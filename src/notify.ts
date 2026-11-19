export class Notify {
	private waiters: Array<() => void> = [];

	notified(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	notifyAll(): void {
		if (this.waiters.length === 0) return;
		const toWake = this.waiters;
		this.waiters = [];
		for (const resolve of toWake) resolve();
	}

}

export class Gate {
	private state = false;
	private waiters: Array<() => void> = [];

	get isClosed(): boolean {
		return this.state;
	}

	close(): void {
		if (this.state) return;
		this.state = true;
		const toWake = this.waiters;
		this.waiters = [];
		for (const resolve of toWake) resolve();
	}

	closed(): Promise<void> {
		if (this.state) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	subscribe(listener: () => void): () => void {
		if (this.state) {
			queueMicrotask(listener);
			return () => {};
		}
		const notify = () => queueMicrotask(listener);
		this.waiters.push(notify);
		return () => {
			const index = this.waiters.indexOf(notify);
			if (index >= 0) this.waiters.splice(index, 1);
		};
	}
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
