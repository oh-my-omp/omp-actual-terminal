export interface ShellHost {
	readonly isCmdShell: (shell: string) => boolean;
}

export const noShellHost: ShellHost = {
	isCmdShell: () => {
		throw new Error("omp-unified-exec: the activating host supplies no cmd.exe test; pass a ShellHost whose isCmdShell classifies an explicit shell");
	},
};

export async function loadShellHost(): Promise<ShellHost> {
	const utils: unknown = await import("@oh-my-pi/pi-utils");
	const procmgr: unknown = typeof utils === "object" && utils !== null && "procmgr" in utils ? utils.procmgr : undefined;
	const isCmdShell: unknown = typeof procmgr === "object" && procmgr !== null && "isCmdShell" in procmgr ? procmgr.isCmdShell : undefined;
	if (typeof isCmdShell !== "function") {
		throw new Error("omp-unified-exec: @oh-my-pi/pi-utils procmgr lacks isCmdShell(); requalify fork-features/shell-host.ts for this omp version");
	}
	return { isCmdShell: isCmdShell as (shell: string) => boolean };
}
