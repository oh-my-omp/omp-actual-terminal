import type { AgentLifecycleApi } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { AgentRegistryApi, AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

export type AgentGeneration = AgentRef;

export type AgentIdentity = {
	readonly agentId: AgentRef["id"];
	readonly generation: AgentGeneration;
};

export interface AgentHost {
	identify(agentId: AgentRef["id"]): AgentIdentity | undefined;
	isParking(agent: AgentIdentity): boolean;
	isAdopted(agent: AgentIdentity): boolean;
	revive(agentId: AgentRef["id"]): Promise<void>;
	onEnded(listener: (generation: AgentGeneration) => void): () => void;
}

export type AgentRegistryHost = Pick<AgentRegistryApi, "get" | "onChange">;
export type AgentLifecycleHost = Pick<AgentLifecycleApi, "has" | "isParking" | "ensureLive">;

export interface AgentHostModules {
	readonly AgentRegistry?: { global(): Partial<AgentRegistryHost> };
}

export interface AgentLifecycleModules {
	readonly AgentLifecycleManager?: { global(): Partial<AgentLifecycleHost> };
}

function parseRegistry(Class: AgentHostModules["AgentRegistry"]): AgentRegistryHost {
	if (Class === undefined || typeof Class.global !== "function") {
		throw new Error("omp-unified-exec: AgentRegistry lacks global()");
	}
	const registry: Partial<AgentRegistryHost> = Class.global();
	const get = registry.get;
	const onChange = registry.onChange;
	if (typeof get !== "function") throw new Error("omp-unified-exec: AgentRegistry lacks get()");
	if (typeof onChange !== "function") throw new Error("omp-unified-exec: AgentRegistry lacks onChange()");
	return { get: get.bind(registry), onChange: onChange.bind(registry) };
}

export async function loadAgentHost(): Promise<AgentHost> {
	const [root, lifecycleModule] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent"),
		import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle"),
	]);
	return parseAgentHost(root, lifecycleModule);
}

export function parseAgentHost(root: AgentHostModules, lifecycleModule: AgentLifecycleModules): AgentHost {
	const registry = parseRegistry(root.AgentRegistry);
	const lifecycle = (): AgentLifecycleHost => {
		const Manager = lifecycleModule.AgentLifecycleManager;
		if (Manager === undefined || typeof Manager.global !== "function") {
			throw new Error("omp-unified-exec: AgentLifecycleManager lacks global()");
		}
		const manager: Partial<AgentLifecycleHost> = Manager.global();
		const isParking = manager.isParking;
		const has = manager.has;
		const ensureLive = manager.ensureLive;
		if (typeof isParking !== "function") throw new Error("omp-unified-exec: AgentLifecycleManager lacks isParking()");
		if (typeof has !== "function") throw new Error("omp-unified-exec: AgentLifecycleManager lacks has()");
		if (typeof ensureLive !== "function") throw new Error("omp-unified-exec: AgentLifecycleManager lacks ensureLive()");
		return { isParking: isParking.bind(manager), has: has.bind(manager), ensureLive: ensureLive.bind(manager) };
	};
	void lifecycle();
	return {
		identify: (agentId) => {
			const ref = registry.get(agentId);
			return ref === undefined ? undefined : { agentId, generation: ref };
		},
		isParking: (agent) => lifecycle().isParking(agent.agentId, agent.generation) === true,
		isAdopted: (agent) => lifecycle().has(agent.agentId, agent.generation) === true,
		revive: async (agentId) => {
			await lifecycle().ensureLive(agentId);
		},
		onEnded: (listener) => {
			const unsubscribe = registry.onChange((event) => {
				const { type, ref } = event;
				if (type === "removed" || (type === "status_changed" && ref.status === "aborted")) listener(ref);
			});
			if (typeof unsubscribe !== "function") {
				throw new Error("omp-unified-exec: AgentRegistry.onChange() returned no unsubscribe");
			}
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
