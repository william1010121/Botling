// How to run a command in the user's shell (the terminal plugin lists the installed shells itself).
// Windows: COMSPEC, PowerShell 7 (pwsh), Windows PowerShell, cmd; none takes login/interactive flags.
// POSIX: the user's shell ($SHELL), then /etc/shells; only there do `-l -i` / `-lc` apply.
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { posix, win32 } from "node:path";

/** What detection reads from the machine; tests replace it to run another platform's rules. */
export interface ShellDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** An executable regular file at an absolute path. */
  isExecutable(path: string): boolean;
  readFile(path: string): string;
  /** The account's login shell, when the OS knows it (POSIX). */
  userShell(): string | undefined;
}

export const systemShellDeps: ShellDeps = {
  get platform() { return process.platform; },
  get env() { return process.env; },
  isExecutable: (path) => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  },
  readFile: (path) => readFileSync(path, "utf8"),
  userShell: () => { try { return userInfo().shell ?? undefined; } catch { return undefined; } },
};

const LOGIN_C = new Set(["bash", "zsh", "sh", "dash", "ksh", "fish"]); // Shells that take `-lc`.

/** The program and arguments that run `command` once: the user's login shell setup as 1.x (zsh -lc on macOS). */
export function commandShell(command: string, deps: ShellDeps = systemShellDeps): [string, string[]] {
  if (deps.platform === "win32") return [deps.env.ComSpec ?? deps.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", command]];
  if (deps.platform === "darwin" && deps.isExecutable("/bin/zsh")) return ["/bin/zsh", ["-lc", command]];
  const user = deps.env.SHELL || deps.userShell();
  if (deps.platform !== "darwin" && user && posix.isAbsolute(user) && LOGIN_C.has(posix.basename(user)) && deps.isExecutable(user)) return [user, ["-lc", command]];
  return ["/bin/sh", ["-lc", command]];
}
