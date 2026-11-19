// Ambient script (no top-level import/export): these modules exist only inside
// oh-my-pi, so their values are parsed at runtime by omp-presentation.ts and
// tern-terminal-hud.ts.

// The Bun global the shared copies reach for `Bun.TOML.parse`; src/pty.ts
// declares the members it needs locally instead of relying on this.
declare namespace Bun {
	export const TOML: { parse(text: string): object };
}
declare module "@oh-my-pi/pi-tui/tools" {
	export const toolRenderers: Readonly<Record<string, unknown>>;
}

declare module "@oh-my-pi/pi-tui/native/state" {
	export const isNativeRendering: unknown;
	export const onNativeRenderingChange: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/modes/interactive-mode" {
	export const InteractiveMode: unknown;
}

declare module "@oh-my-pi/pi-tui/theme" {
	export const isLightTheme: unknown;
	export const getCurrentThemeName: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/internal-urls" {
	export const InternalUrlRouter: unknown;
}

// Types for the byte-identical shared copies in fork-features/omomp-shared/:
// they name these modules statically, so the ambient declarations carry the
// members the copies actually read rather than `unknown`.

declare module "@oh-my-pi/pi-coding-agent/internal-urls/types" {
	/** omp's parsed internal URL; identical to `URL` at runtime. */
	export type InternalUrl = URL;
	export interface SchemeSpec {
		readonly backing: "file" | "virtual" | "remote" | "device";
		readonly selectors: string;
		readonly immutable: boolean;
	}
	export interface InternalResource {
		readonly url: string;
		readonly content: string;
		readonly contentType: string;
		readonly immutable: boolean;
	}
	export interface ProtocolHandler {
		readonly scheme: string;
		readonly spec: SchemeSpec;
		resolve(url: InternalUrl, context?: unknown): Promise<InternalResource>;
		locate?(url: InternalUrl, context?: unknown, options?: unknown): Promise<string | null>;
	}
}

declare module "@oh-my-pi/pi-coding-agent/internal-urls/router" {
	import type { ProtocolHandler, SchemeSpec } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
	export declare class InternalUrlRouter {
		static instance(): InternalUrlRouter;
		register(handler: ProtocolHandler): void;
		isBuiltin(scheme: string): boolean;
		unregister(scheme: string): boolean;
		getHandler(scheme: string): ProtocolHandler | undefined;
		specs(): ReadonlyMap<string, SchemeSpec>;
	}
}

declare module "@oh-my-pi/pi-natives" {
	export function rasterizeSvg(input: Uint8Array, maxWidthPx: number, maxHeightPx: number): Promise<Uint8Array>;
}

declare module "@oh-my-pi/pi-coding-agent/config/registry" {
	export const lookup: unknown;
}

declare module "@oh-my-pi/pi-coding-agent" {
	export const AgentRegistry: unknown;
	export const CRITICAL_BASH_PATTERNS: unknown;
	export const getAgentDir: unknown;

	/** The members of the host's `zod` namespace export the shared copies use. */
	export namespace zod {
		/** One parse issue reported by a failed `safeParse`. */
		export interface ZodLikeIssue {
			readonly path: readonly (string | number)[];
			readonly message: string;
		}
		export type ZodLikeSafeParseResult<Out> =
			| { readonly success: true; readonly data: Out }
			| { readonly success: false; readonly error: { readonly issues: readonly ZodLikeIssue[] } };
		export interface ZodLikeSchema<out Out> {
			safeParse(value: unknown): ZodLikeSafeParseResult<Out>;
			refine(predicate: (value: Out) => unknown, message?: string): ZodLikeSchema<Out>;
		}
	}
	export type ZodInfer<Schema> = Schema extends zod.ZodLikeSchema<infer Out> ? Out : never;
	export interface ZodLike {
		string(): zod.ZodLikeSchema<string>;
		object<Shape extends Readonly<Record<string, zod.ZodLikeSchema<unknown>>>>(
			shape: Shape,
		): zod.ZodLikeSchema<{ readonly [Key in keyof Shape]: ZodInfer<Shape[Key]> }>;
		array<Out>(element: zod.ZodLikeSchema<Out>): zod.ZodLikeSchema<Out[]>;
		union<const Members extends readonly zod.ZodLikeSchema<unknown>[]>(
			members: Members,
		): zod.ZodLikeSchema<ZodInfer<Members[number]>>;
		enum<const Values extends readonly [string, ...string[]]>(values: Values): zod.ZodLikeSchema<Values[number]>;
	}
	export const z: ZodLike;
}

declare module "@oh-my-pi/pi-coding-agent/judgment" {
	export const resolveJudge: unknown;
	export const journalJudgmentUsage: unknown;
	export const sharedJudgmentCache: unknown;
	export const kindOf: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/config/model-resolver" {
	export const resolveRoleChain: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/config/model-roles" {
	export const roleCandidatePool: unknown;
}

declare module "@oh-my-pi/pi-ai" {
	export const completeSimple: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/exec/settings" {
	export const cfgBashPatterns: unknown;
	export const cfgBashAllowCompoundCommands: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/tools/shell-tokenize" {
	export const tokenizeShellSegments: unknown;
	export const isShellEnvironmentAssignment: unknown;
	export const extractLiteralAndChainSegments: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/tools/approval" {
	export const truncateForPrompt: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/tools/gh-cache-invalidation" {
	export const invalidateGithubCacheForBashCommand: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle" {
	export const AgentLifecycleManager: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader" {
	export const getPluginSettings: unknown;
}

declare module "@oh-my-pi/pi-utils" {
	export const procmgr: unknown;

	/** The members of the host's ptree helper the shared copies use. */
	export namespace ptree {
		export interface WaitResult {
			readonly exitCode: number | undefined;
			readonly exitError: Error | undefined;
			readonly stdout: string;
			readonly stderr: string;
		}
		export interface WaitOptions {
			readonly allowAbort?: boolean;
			readonly allowNonZero?: boolean;
			readonly stderr?: string;
		}
		export interface SpawnOptions {
			readonly timeout?: number;
			readonly stderr?: string;
			readonly env?: NodeJS.ProcessEnv;
		}
		export interface SpawnedProcess extends Disposable {
			wait(options?: WaitOptions): Promise<WaitResult>;
		}
		export class Exception extends Error {}
		export class AbortError extends Exception {}
		export class TimeoutError extends AbortError {}
		export function spawn(cmd: readonly string[], opts?: SpawnOptions): SpawnedProcess;
	}
}
