// Which shells this machine has for the terminal's tabs, and how to start one as an interactive session.
// Windows: COMSPEC, PowerShell 7 (pwsh), Windows PowerShell, cmd; none takes login/interactive flags.
// POSIX: the user's shell ($SHELL), then /etc/shells; only there do `-l -i` apply. (The core keeps `commandShell`, which runs one command.)
import { posix, win32 } from "node:path";
import { systemShellDeps, type ShellDeps } from "../../../src/core/shell";

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
