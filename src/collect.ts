import type { TerminalObservation, TerminalProjection } from "./terminal-screen.ts";

export interface ScreenOutput {
	readonly kind: "screen";
	readonly observation: TerminalObservation;
	readonly terminalUrl?: string;
}

export interface FinalScreenOutput {
	readonly kind: "final-screen";
	readonly projection: TerminalProjection;
	readonly terminalUrl: string;
}

export interface NoOutput {
	readonly kind: "none";
}

export type CollectResult = ScreenOutput | FinalScreenOutput | NoOutput;

export const NO_OUTPUT: NoOutput = { kind: "none" };
