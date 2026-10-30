// Which shells this machine has, and how to run a command or an interactive session in one.
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

export interface InstalledShells { shells: string[]; defaultShell: string }

/** Shells the terminal may offer, the first of which is the default. Throws when there is none. */
export function installedShells(deps: ShellDeps = systemShellDeps): InstalledShells {
  const configured = deps.platform === "win32" ? windowsShells(deps)[0] : deps.userShell() || deps.env.SHELL || "/bin/sh";
  let candidates: string[];
  if (deps.platform === "win32") candidates = windowsShells(deps);
  else {
    let listed: string[] = [];
    try { listed = deps.readFile("/etc/shells").split("\n").map((line) => line.trim()).filter((line) => line.startsWith("/")); } catch { /* none listed */ }
    candidates = [configured!, ...listed, "/opt/homebrew/bin/fish", "/usr/local/bin/fish"];
  }
  const shells = [...new Set(candidates)].filter((file) => file && (deps.platform === "win32" ? win32.isAbsolute(file) : posix.isAbsolute(file)) && deps.isExecutable(file));
  if (!shells.length) throw new Error("No installed interactive shell found.");
  return { shells, defaultShell: configured && shells.includes(configured) ? configured : shells[0]! };
}

function windowsShells(deps: ShellDeps): string[] {
  const { env } = deps;
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "C:\\Windows";
  const programs = env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files";
  const onPath = (name: string) => (env.Path ?? env.PATH ?? "").split(win32.delimiter).filter((dir) => win32.isAbsolute(dir)).map((dir) => win32.join(dir, name));
  const found = [
    env.ComSpec ?? env.COMSPEC,
    ...onPath("pwsh.exe"), win32.join(programs, "PowerShell", "7", "pwsh.exe"),
    ...onPath("powershell.exe"), win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    win32.join(root, "System32", "cmd.exe"),
  ].filter((file): file is string => !!file && win32.isAbsolute(file));
  const seen = new Set<string>();
  return found.filter((file) => { const key = file.toLowerCase(); return !seen.has(key) && !!seen.add(key); });
}

/** The arguments that start `shell` as an interactive session: a login shell on POSIX, plain on Windows. */
export function interactiveArgs(deps: Pick<ShellDeps, "platform"> = systemShellDeps): string[] {
  return deps.platform === "win32" ? [] : ["-l", "-i"];
}

const LOGIN_C = new Set(["bash", "zsh", "sh", "dash", "ksh", "fish"]); // Shells that take `-lc`.

/** The program and arguments that run `command` once: the user's login shell setup as 1.x (zsh -lc on macOS). */
export function commandShell(command: string, deps: ShellDeps = systemShellDeps): [string, string[]] {
  if (deps.platform === "win32") return [deps.env.ComSpec ?? deps.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", command]];
  if (deps.platform === "darwin" && deps.isExecutable("/bin/zsh")) return ["/bin/zsh", ["-lc", command]];
  const user = deps.env.SHELL || deps.userShell();
  if (deps.platform !== "darwin" && user && posix.isAbsolute(user) && LOGIN_C.has(posix.basename(user)) && deps.isExecutable(user)) return [user, ["-lc", command]];
  return ["/bin/sh", ["-lc", command]];
}
