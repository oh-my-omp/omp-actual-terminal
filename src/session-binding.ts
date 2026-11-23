import type { ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import type { AgentRef, AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";

/** Settings scope of a bound session; the host's own class, so `Setting.get(scope)` accepts it by identity. */
export type HostSettings = Settings;

/** The session manager as the plugin uses it: the handle every host session declares. */
export type SessionManager = AgentSessionHandle["sessionManager"];

/**
 * What the plugin binds to. Registry entries can be replaced by same-id helper sessions, so the
 * plugin reads these once and from then on only rechecks the session manager by identity.
 */
export type BoundSession = Pick<AgentSession, "settings" | "skills" | "getImageAttachments" | "asyncJobManager"> & Pick<AgentSessionHandle, "sessionManager">;

/** Registry lookup the plugin needs: the ref of the agent's current generation. */
export type SessionRegistry = Pick<AgentRegistryApi, "get">;

export type HostBindingState =
	| { readonly kind: "pending" }
	| { readonly kind: "unbound"; readonly reason: "no-registry-entry" | "identity-mismatch" }
	| {
		readonly kind: "bound";
		readonly session: BoundSession;
		readonly agentId: string;
		/** The root agent of the session's agent tree: it owns the session's terminal jobs. */
		readonly rootAgentId: string;
	};

/** The part of the extension context the binding reads. */
export type BindingContext = {
	readonly agentId: AgentRef["id"] | undefined;
	readonly sessionManager: SessionManager;
};

/**
 * `AgentRef.session` is declared as the minimal cross-agent handle, so the members the plugin
 * needs are not on it: narrow once here. `settings` is the host's nominal `Settings`, so a
 * structural check can only prove its presence.
 */
function isBoundSession(session: AgentRef["session"]): session is AgentSessionHandle & BoundSession {
	return typeof session === "object" && session !== null && "settings" in session && "sessionManager" in session
		&& "skills" in session && "getImageAttachments" in session && "asyncJobManager" in session;
}

/**
 * Terminals are jobs of the root agent: omp cancels a subagent's own jobs when its task ends, and a
 * subagent's terminal outlives that task.
 */
function rootAgentOf(host: SessionRegistry, agentId: string): string {
	let id = agentId;
	for (let parent = host.get(id)?.parentId; parent !== undefined; parent = host.get(id)?.parentId) id = parent;
	return id;
}

export function bindingContext(ctx: Pick<ExtensionContext, "agent"> & Pick<AgentSessionHandle, "sessionManager">): BindingContext {
	// A partial host context may carry no agent; the binding then stays unbound until one does.
	const agent: Partial<ExtensionContext["agent"]> | undefined = ctx.agent;
	const id = agent?.id;
	return { agentId: typeof id === "string" ? id : undefined, sessionManager: ctx.sessionManager };
}

export function bindSession(host: SessionRegistry, ctx: BindingContext): HostBindingState {
	const { agentId } = ctx;
	if (agentId === undefined) return { kind: "unbound", reason: "no-registry-entry" };
	const session = host.get(agentId)?.session ?? null;
	if (!isBoundSession(session)) return { kind: "unbound", reason: "no-registry-entry" };
	if (session.sessionManager !== ctx.sessionManager) return { kind: "unbound", reason: "identity-mismatch" };
	return { kind: "bound", session, agentId, rootAgentId: rootAgentOf(host, agentId) };
}

export function recheckBinding(binding: HostBindingState, ctx: BindingContext): HostBindingState {
	switch (binding.kind) {
		case "pending":
		case "unbound":
			return binding;
		case "bound":
			return binding.session.sessionManager === ctx.sessionManager
				? binding : { kind: "unbound", reason: "identity-mismatch" };
	}
}
