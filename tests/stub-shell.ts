import { IS_WINDOWS } from "../src/shell.ts";

export const STUB_SHELL_PATH = IS_WINDOWS ? () => "bash" : () => undefined;

export const stubShellHost = {
	isCmdShell: (shell: string): boolean => /(^|[\\/])cmd(\.exe)?$/i.test(shell),
} as const;
