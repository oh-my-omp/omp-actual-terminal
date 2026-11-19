import { spawn as spawnProcess } from "node:child_process";
import { mock } from "bun:test";

const ok = (data) => ({ success: true, data });
const failIssues = (issues) => ({ success: false, error: { issues } });

class Schema {
	refine(predicate, message) {
		const inner = this;
		const refined = new Schema();
		refined.safeParse = (value) => {
			const base = inner.safeParse(value);
			if (!base.success) return base;
			if (predicate(base.data)) return base;
			const detail = typeof message === "string" ? message : "invalid value";
			return failIssues([{ path: [], message: detail }]);
		};
		return refined;
	}
}

const stringSchema = () => {
	const schema = new Schema();
	schema.safeParse = (value) =>
		typeof value === "string" ? ok(value) : failIssues([{ path: [], message: "expected string" }]);
	return schema;
};

const objectSchema = (shape) => {
	const schema = new Schema();
	schema.safeParse = (value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return failIssues([{ path: [], message: "expected object" }]);
		}
		const out = {};
		const issues = [];
		for (const key of Object.keys(shape)) {
			const parsed = shape[key].safeParse(value[key]);
			if (parsed.success) out[key] = parsed.data;
			else for (const issue of parsed.error.issues) issues.push({ path: [key, ...issue.path], message: issue.message });
		}
		return issues.length === 0 ? ok(out) : failIssues(issues);
	};
	return schema;
};

const arraySchema = (element) => {
	const schema = new Schema();
	schema.safeParse = (value) => {
		if (!Array.isArray(value)) return failIssues([{ path: [], message: "expected array" }]);
		const out = [];
		const issues = [];
		for (const [index, item] of value.entries()) {
			const parsed = element.safeParse(item);
			if (parsed.success) out[index] = parsed.data;
			else for (const issue of parsed.error.issues) issues.push({ path: [index, ...issue.path], message: issue.message });
		}
		return issues.length === 0 ? ok(out) : failIssues(issues);
	};
	return schema;
};

const unionSchema = (members) => {
	const schema = new Schema();
	schema.safeParse = (value) => {
		const issues = [];
		for (const member of members) {
			const parsed = member.safeParse(value);
			if (parsed.success) return parsed;
			issues.push(...parsed.error.issues);
		}
		return failIssues(issues.length > 0 ? issues : [{ path: [], message: "no union member matched" }]);
	};
	return schema;
};

const enumSchema = (values) => {
	const schema = new Schema();
	schema.safeParse = (value) =>
		values.includes(value)
			? ok(value)
			: failIssues([{ path: [], message: `expected one of ${values.map(String).join(", ")}` }]);
	return schema;
};

const z = {
	string: stringSchema,
	object: objectSchema,
	array: arraySchema,
	union: unionSchema,
	enum: enumSchema,
};

mock.module("@oh-my-pi/pi-coding-agent", () => ({ z }));

class AbortError extends Error {}
class TimeoutError extends AbortError {}
class NonZeroExitError extends AbortError {
	constructor(exitCode) {
		super(`exit code ${exitCode}`);
		this.exitCode = exitCode;
	}
}

const ptree = {
	TimeoutError,
	AbortError,
	NonZeroExitError,
	spawn(cmd, opts = {}) {
		const child = spawnProcess(cmd[0], cmd.slice(1), {
			env: opts.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks = [];
		const stderrChunks = [];
		child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk));
		child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
		return {
			wait() {
				return new Promise((resolve) => {
					let settled = false;
					let timer = undefined;
					const settle = (result) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						resolve(result);
					};
					if (opts.timeout !== undefined) {
						timer = setTimeout(() => {
							child.kill("SIGKILL");
							settle({
								exitCode: undefined,
								exitError: new TimeoutError(`timed out after ${opts.timeout}ms`),
								stdout: Buffer.concat(stdoutChunks).toString("utf8"),
								stderr: Buffer.concat(stderrChunks).toString("utf8"),
							});
						}, opts.timeout);
					}
					child.on("error", (error) => {
						settle({
							exitCode: undefined,
							exitError: error,
							stdout: Buffer.concat(stdoutChunks).toString("utf8"),
							stderr: Buffer.concat(stderrChunks).toString("utf8"),
						});
					});
					child.on("close", (code, signal) => {
						settle({
							exitCode: code ?? undefined,
							exitError: code === 0 ? undefined : new NonZeroExitError(code ?? `signal ${signal}`),
							stdout: Buffer.concat(stdoutChunks).toString("utf8"),
							stderr: Buffer.concat(stderrChunks).toString("utf8"),
						});
					});
				});
			},
			[Symbol.dispose]() {
				child.kill("SIGKILL");
			},
		};
	},
};

mock.module("@oh-my-pi/pi-utils", () => ({ ptree }));
