import type { ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import type { AgentRef, AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";

export type HostSettings = Settings;

export type SessionManager = AgentSessionHandle["sessionManager"];

export type BoundSession = Pick<AgentSession, "settings"> & Pick<AgentSessionHandle, "sessionManager">;

export type SessionRegistry = Pick<AgentRegistryApi, "get">;

export type HostBindingState =
	| { readonly kind: "pending" }
	| { readonly kind: "unbound"; readonly reason: "no-registry-entry" | "identity-mismatch" }
	| { readonly kind: "bound"; readonly session: BoundSession; readonly agentId: string };

export type BindingContext = {
	readonly agentId: AgentRef["id"] | undefined;
	readonly sessionManager: SessionManager;
};

function isBoundSession(session: AgentRef["session"]): session is AgentSessionHandle & BoundSession {
	return typeof session === "object" && session !== null && "settings" in session && "sessionManager" in session;
}

export function bindingContext(ctx: Pick<ExtensionContext, "agent"> & Pick<AgentSessionHandle, "sessionManager">): BindingContext {
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
	return { kind: "bound", session, agentId };
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
