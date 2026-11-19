declare const generationBrand: unique symbol;

export interface AgentGeneration {
	readonly [generationBrand]: true;
}

export interface AgentIdentity {
	readonly agentId: string;
	readonly generation: AgentGeneration;
}

export interface AgentHost {
	identify(agentId: string): AgentIdentity | undefined;
	isParking(agent: AgentIdentity): boolean;
	isAdopted(agent: AgentIdentity): boolean;
	revive(agentId: string): Promise<void>;
	onEnded(listener: (generation: AgentGeneration) => void): () => void;
}

function property(value: unknown, name: string): unknown {
	return (typeof value === "object" || typeof value === "function") && value !== null && name in value ? Reflect.get(value, name) : undefined;
}

function method(owner: unknown, name: string, from: string): (...args: unknown[]) => unknown {
	const value = property(owner, name);
	if (typeof value !== "function") throw new Error(`omp-unified-exec: ${from} lacks ${name}()`);
	return (...args) => Reflect.apply(value, owner, args);
}

function singleton(module: unknown, name: string): unknown {
	const owner = property(module, name);
	return method(owner, "global", name)();
}

export async function loadAgentHost(): Promise<AgentHost> {
	const [root, lifecycleModule] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent"),
		import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle"),
	]);
	return parseAgentHost(root, lifecycleModule);
}

export function parseAgentHost(root: unknown, lifecycleModule: unknown): AgentHost {
	const registry = singleton(root, "AgentRegistry");
	const get = method(registry, "get", "AgentRegistry");
	const onChange = method(registry, "onChange", "AgentRegistry");
	const lifecycle = () => singleton(lifecycleModule, "AgentLifecycleManager");
	for (const name of ["isParking", "has", "ensureLive"]) method(lifecycle(), name, "AgentLifecycleManager");
	return {
		identify: (agentId) => {
			const ref = get(agentId);
			return typeof ref === "object" && ref !== null ? { agentId, generation: ref as AgentGeneration } : undefined;
		},
		isParking: (agent) => method(lifecycle(), "isParking", "AgentLifecycleManager")(agent.agentId, agent.generation) === true,
		isAdopted: (agent) => method(lifecycle(), "has", "AgentLifecycleManager")(agent.agentId, agent.generation) === true,
		revive: async (agentId) => {
			await method(lifecycle(), "ensureLive", "AgentLifecycleManager")(agentId);
		},
		onEnded: (listener) => {
			const unsubscribe = onChange((event: unknown) => {
				const type = property(event, "type");
				const ref = property(event, "ref");
				if (typeof ref !== "object" || ref === null) return;
				if (type === "removed" || (type === "status_changed" && property(ref, "status") === "aborted")) listener(ref as AgentGeneration);
			});
			if (typeof unsubscribe !== "function") throw new Error("omp-unified-exec: AgentRegistry.onChange() returned no unsubscribe");
			return () => void unsubscribe();
		},
	};
}

export interface ParkedRuntime {
	end(): Promise<void>;
}

export class ParkedRuntimes<T extends ParkedRuntime> {
	private readonly held = new Map<AgentGeneration, T>();
	private readonly endings = new Set<Promise<void>>();
	private unsubscribe: (() => void) | undefined;

	hold(host: AgentHost, generation: AgentGeneration, runtime: T): void {
		this.held.set(generation, runtime);
		this.unsubscribe ??= host.onEnded((ended) => {
			const parked = this.held.get(ended);
			if (!parked) return;
			this.held.delete(ended);
			const ending = parked.end();
			this.endings.add(ending);
			void ending.finally(() => this.endings.delete(ending));
		});
	}

	take(generation: AgentGeneration): T | undefined {
		const runtime = this.held.get(generation);
		this.held.delete(generation);
		return runtime;
	}

	async settled(): Promise<void> {
		await Promise.all(this.endings);
	}

	get size(): number {
		return this.held.size;
	}
}

const registrySymbol = Symbol.for("omp-unified-exec.parked-runtimes");
const processGlobal = globalThis as typeof globalThis & { [registrySymbol]?: ParkedRuntimes<ParkedRuntime> };

export function parkedRuntimes<T extends ParkedRuntime>(): ParkedRuntimes<T> {
	return (processGlobal[registrySymbol] ??= new ParkedRuntimes()) as ParkedRuntimes<T>;
}
