import { randomBytes } from "node:crypto";
import { closeSync, constants, createReadStream, createWriteStream, openSync, type Stats, writev } from "node:fs";
import { link, lstat, open, readdir, unlink, utimes, type FileHandle } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export const LOG_ARCHIVE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOG_PREFIX = "pi-unified-exec-";

interface LogArchiveRegistry {
	readonly openLogs: Set<string>;
	timer: NodeJS.Timeout | undefined;
	scan: Promise<readonly ArchiveResult[]> | undefined;
}

const registrySymbol = Symbol.for("omp-unified-exec.log-archive");
const processGlobal = globalThis as typeof globalThis & { [registrySymbol]?: LogArchiveRegistry };
const registry: LogArchiveRegistry = processGlobal[registrySymbol] ??= { openLogs: new Set(), timer: undefined, scan: undefined };
export const openSessionLogs: ReadonlySet<string> = registry.openLogs;

export type LogName =
	| { readonly kind: "owned"; readonly pid: number }
	| { readonly kind: "legacy" };

export type SkipReason =
	| "not_regular"
	| "foreign_owner"
	| "recent"
	| "writer_alive"
	| "changed"
	| "archive_exists"
	| "error";

export type ArchiveResult =
	| { readonly name: string; readonly kind: "archived" }
	| { readonly name: string; readonly kind: "skipped"; readonly reason: SkipReason; readonly detail?: string };

export interface ArchivePolicy {
	readonly now: number;
	readonly bootTime: number;
	readonly selfPid: number;
	readonly openLogs: ReadonlySet<string>;
	readonly pidExists: (pid: number) => boolean;
}

export function sessionLogName(sessionId: number): string {
	return `${LOG_PREFIX}${process.pid}-${sessionId}-${randomBytes(4).toString("hex")}.log`;
}

export function parseLogName(name: string): LogName | undefined {
	const owned = /^pi-unified-exec-(\d+)-\d+-[0-9a-f]{8}\.log$/.exec(name);
	if (owned) return { kind: "owned", pid: Number(owned[1]) };
	if (/^pi-unified-exec-\d+-[0-9a-f]{8}\.log$/.test(name)) return { kind: "legacy" };
	return undefined;
}

const WRITEV_MAX_BUFFERS = 1024;

function unwrittenTail(batch: readonly Uint8Array[], written: number): Uint8Array[] {
	const tail: Uint8Array[] = [];
	let offset = written;
	for (const chunk of batch) {
		if (offset >= chunk.length) {
			offset -= chunk.length;
			continue;
		}
		tail.push(offset === 0 ? chunk : chunk.subarray(offset));
		offset = 0;
	}
	return tail;
}

export class SessionLog {
	private pending: Uint8Array[] = [];
	private pendingBytes = 0;
	private writing = false;
	private ending: PromiseWithResolvers<void> | undefined;
	private closed = false;

	private constructor(readonly path: string, private readonly fd: number, private readonly onError: (error: Error) => void) {
		registry.openLogs.add(path);
	}

	static open(path: string, onError: (error: Error) => void): SessionLog {
		closeSync(openSync(path, "w"));
		return new SessionLog(path, openSync(path, "a"), onError);
	}

	get backlogBytes(): number {
		return this.pendingBytes;
	}

	write(chunk: Uint8Array): void {
		if (this.closed || this.ending) return;
		this.pending.push(chunk);
		this.pendingBytes += chunk.length;
		this.flush();
	}

	end(): Promise<void> {
		if (!this.ending) {
			this.ending = Promise.withResolvers<void>();
			if (this.closed) this.ending.resolve();
			else this.flush();
		}
		return this.ending.promise;
	}

	private flush(): void {
		if (this.writing || this.closed) return;
		if (this.pending.length === 0) {
			if (this.ending) this.close();
			return;
		}
		const batch = this.pending.length <= WRITEV_MAX_BUFFERS ? this.pending : this.pending.slice(0, WRITEV_MAX_BUFFERS);
		this.pending = batch === this.pending ? [] : this.pending.slice(WRITEV_MAX_BUFFERS);
		const batchBytes = batch.reduce((bytes, chunk) => bytes + chunk.length, 0);
		this.writing = true;
		// `writev` may write fewer bytes than the batch holds — a short write at the
		// file-size limit, among others — and report no error for it.
		writev(this.fd, batch, (error, bytesWritten) => {
			this.writing = false;
			if (error) {
				this.pending = [];
				this.pendingBytes = 0;
				this.close();
				this.onError(error);
				return;
			}
			const written = Math.min(bytesWritten, batchBytes);
			this.pendingBytes -= written;
			if (written < batchBytes) {
				// A write that reports no progress would retry forever and never let
				// `end` settle: report it once, like any other failed write.
				if (written === 0) {
					this.pending = [];
					this.pendingBytes = 0;
					this.close();
					this.onError(new Error(`writev wrote 0 of ${batchBytes} log bytes to ${this.path}`));
					return;
				}
				this.pending = unwrittenTail(batch, written).concat(this.pending);
			}
			this.flush();
		});
	}

	private close(): void {
		this.closed = true;
		try {
			closeSync(this.fd);
		} finally {
			registry.openLogs.delete(this.path);
			this.ending?.resolve();
		}
	}
}

export function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function writerGone(path: string, name: LogName, mtimeMs: number, policy: ArchivePolicy): boolean {
	if (mtimeMs < policy.bootTime) return true;
	switch (name.kind) {
		case "legacy": return false;
		case "owned":
			return name.pid === policy.selfPid ? !policy.openLogs.has(path) : !policy.pidExists(name.pid);
	}
}

function sameFile(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

async function removeQuietly(path: string): Promise<void> {
	await unlink(path).catch(() => undefined);
}

export async function archiveLog(dir: string, fileName: string, name: LogName, policy: ArchivePolicy): Promise<ArchiveResult> {
	const path = join(dir, fileName);
	const skip = (reason: SkipReason, detail?: string): ArchiveResult => ({ name: fileName, kind: "skipped", reason, detail });
	let source: FileHandle | undefined;
	let temp: string | undefined;
	try {
		const before = await lstat(path);
		if (!before.isFile()) return skip("not_regular");
		const uid = process.getuid?.();
		if (uid !== undefined && before.uid !== uid) return skip("foreign_owner");
		if (before.mtimeMs > policy.now || policy.now - before.mtimeMs < LOG_ARCHIVE_AGE_MS) return skip("recent");
		if (!writerGone(path, name, before.mtimeMs, policy)) return skip("writer_alive");

		source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		if (!sameFile(before, await source.stat())) return skip("changed");

		temp = join(dir, `${fileName}.gz.${randomBytes(6).toString("hex")}.tmp`);
		await pipeline(
			createReadStream("", { fd: source.fd, autoClose: false, start: 0 }),
			createGzip(),
			createWriteStream(temp, { flags: "wx", mode: 0o600 }),
		);
		const written = await open(temp, "r+");
		try {
			await written.sync();
		} finally {
			await written.close();
		}
		await utimes(temp, before.atime, before.mtime);
		if (!sameFile(before, await source.stat())) return skip("changed");
		await source.close();
		source = undefined;

		const archive = `${path}.gz`;
		try {
			await link(temp, archive);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return skip("archive_exists");
			throw err;
		}
		const current = await lstat(path);
		if (!current.isFile() || !sameFile(before, current)) {
			await removeQuietly(archive);
			return skip("changed");
		}
		await unlink(path);
		return { name: fileName, kind: "archived" };
	} catch (err) {
		return skip("error", err instanceof Error ? err.message : String(err));
	} finally {
		await source?.close().catch(() => undefined);
		if (temp) await removeQuietly(temp);
	}
}

export async function archiveLogs(dir: string, policy: ArchivePolicy): Promise<readonly ArchiveResult[]> {
	const results: ArchiveResult[] = [];
	for (const fileName of await readdir(dir)) {
		const name = parseLogName(fileName);
		if (name) results.push(await archiveLog(dir, fileName, name, policy));
	}
	return results;
}

function runScan(): void {
	if (registry.scan) return;
	const now = Date.now();
	const policy: ArchivePolicy = { now, bootTime: now - uptime() * 1000, selfPid: process.pid, openLogs: registry.openLogs, pidExists };
	registry.scan = archiveLogs(tmpdir(), policy)
		.catch((): readonly ArchiveResult[] => [])
		.finally(() => { registry.scan = undefined; });
}

export function scheduleLogArchive(): void {
	clearInterval(registry.timer);
	registry.timer = setInterval(runScan, SCAN_INTERVAL_MS);
	registry.timer.unref();
	runScan();
}
