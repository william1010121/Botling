// Finder/LaunchServices do not read the user's interactive shell PATH. Search stable CLI install
// locations without sourcing shell startup files or importing another environment (or its secrets).
import { accessSync, constants, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export function executableEnvironment(env: Record<string, string>, platform = process.platform): Record<string, string> {
  if (platform === "win32") return { ...env }; // Keep Windows' native PATH/PATHEXT lookup.
  const home = env.HOME ?? homedir();
  const bin = (folder: string | undefined) => folder && isAbsolute(folder) ? join(folder, "bin") : "";
  const paths = [
    ...(env.PATH ?? "").split(delimiter),
    join(home, ".local/bin"), join(home, ".npm-global/bin"),
    bin(env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix), env.NVM_BIN ?? "",
    bin(env.VOLTA_HOME), join(home, ".volta/bin"), join(home, ".asdf/shims"),
    join(home, ".local/share/mise/shims"), join(home, ".nvm/current/bin"),
    join(home, ".local/share/fnm/aliases/default/bin"),
    join(home, ".nix-profile/bin"), join(home, ".local/state/nix/profiles/profile/bin"),
    `/etc/profiles/per-user/${userInfo().username}/bin`, "/run/current-system/sw/bin",
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ];
  // Never search the bot's project folder because PATH was empty or contained a relative entry.
  return { ...env, PATH: [...new Set(paths.filter(path => isAbsolute(path)))].join(delimiter) };
}

/** Resolve bare names only. An explicit path is authoritative, even if missing or not executable. */
export function resolveExecutable(command: string, env: Record<string, string>): string {
  if (process.platform === "win32" || command.includes("/") || command.includes("\\")) return command;
  for (const folder of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(folder)) continue;
    const candidate = join(folder, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* Absent, broken symlink, or not executable: try the next directory. */ }
  }
  return command; // Preserve spawn's asynchronous error/lifecycle handling.
}

export function cliStartError(engine: "claude" | "codex", command: string, error: Error): string {
  const base = `Could not start ${command}: ${error.message}`;
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") return base;
  return `${base}. Check that the working folder exists and the ${engine} CLI is installed. For a custom install, set BOTLING_${engine.toUpperCase()}_PATH to its absolute executable path in the app launcher. npm installs also need Node.js on PATH or in a standard install location.`;
}
