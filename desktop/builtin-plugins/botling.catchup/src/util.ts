// What the summaries need of Botling's own helpers, kept here so the plugin depends on its API only.
// Each must stay byte-for-byte what the core does (the summary prompt and its cache keys come from
// them); test/util.test.ts checks them against the core's.
import { accessSync, constants, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export type AppLanguage = "en" | "zh-Hant";

/** The name the summary model is told to write in (prompts.ts `LANGUAGE_PROMPT_NAMES`). */
export const LANGUAGE_PROMPT_NAMES: Record<AppLanguage, string> = {
  en: "English",
  "zh-Hant": "Traditional Chinese (as used in Taiwan)",
};
export const appLanguage = (value: unknown): AppLanguage => (value === "zh-Hant" ? "zh-Hant" : "en");

/** Top-level summary content: app notifications are sources too, without being assistant heads (contract/summary.ts). */
export const isSummaryReply = (message: { role: string }): boolean => message.role === "bot" || message.role === "notice";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Swift's `text.count`: grapheme clusters (briefing.ts). */
export const characterCount = (text: string) => { let n = 0; for (const _ of segmenter.segment(text)) n++; return n; };
/** Swift's `String(text.prefix(n))`. */
export function characterPrefix(text: string, n: number): string {
  if (text.length <= n) return text;
  let out = "";
  let count = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (count++ >= n) break;
    out += segment;
  }
  return out;
}

/** Swift dates: seconds since 2001 (store/records.ts). */
const SWIFT_EPOCH_MS = Date.UTC(2001, 0, 1);
export const toSwiftDate = (ms: number = Date.now()): number => (ms - SWIFT_EPOCH_MS) / 1000;
export const fromSwiftDate = (seconds: number): number => SWIFT_EPOCH_MS + seconds * 1000;

/** Written beside, then renamed into place: a crash leaves the old file or the new one. */
export function writeFileAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try { writeFileSync(temporary, text); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}

/**
 * The environment a summary CLI runs in, as the core starts its own (agent/runner.ts `childEnvironment`,
 * process/executable.ts): the host's, without a parent Claude's markers, PATH searched in the usual
 * install folders too (Finder does not give an app the shell's PATH).
 */
export function childEnvironment(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_ENTRYPOINT", "ELECTRON_RUN_AS_NODE", "CCB_PLUGIN_HOST"]) delete env[key];
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  if (process.platform === "win32") return env;
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
  return { ...env, PATH: [...new Set(paths.filter((path) => isAbsolute(path)))].join(delimiter) };
}

/** A bare name found on PATH; an explicit path is used as it is. */
export function resolveExecutable(command: string, env: Record<string, string>): string {
  if (process.platform === "win32" || command.includes("/") || command.includes("\\")) return command;
  for (const folder of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(folder)) continue;
    const candidate = join(folder, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return command;
}

/** Ends a child started in a process group of its own, with what it started. */
export function killGroup(child: { pid?: number; kill(signal: NodeJS.Signals): boolean }) {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
  }
}
