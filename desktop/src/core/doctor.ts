import { agyRuntimeStatus } from './agy-runtime-settings';
// Port of Sources/ClaudeCodeBotCore/Doctor.swift. No model calls, installs or sign-in changes.
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { DoctorCheck, DoctorView } from "../contract/doctor";
import { childEnvironment } from "./agent/runner";
import { resolveExecutable } from "./process/executable";

export const DOCTOR_TIMEOUT_MS = 10_000;
type Tool = "claude" | "codex";
export interface CommandResult { output: string; exitCode: number; timedOut: boolean }
export type Run = (path: string, args: string[], timeout: number) => Promise<CommandResult | null>;
type Auth = { state: "signedIn"; how: string } | { state: "signedOut" | "unknown" };
const tools = {
  claude: { name: "Claude Code", package: "@anthropic-ai/claude-code", minimum: "2.1.111", reason: "the oldest that takes --effort xhigh", auth: ["auth", "status"] },
  codex: { name: "Codex", package: "@openai/codex", minimum: "0.99.0", reason: "the oldest whose codex exec takes --ephemeral", auth: ["login", "status"] },
};
export const cliVersion = (text: string | null): string | null => text?.match(/\d+(\.\d+)+/)?.[0] ?? null;
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
export function parseLatest(output: string): string | null {
  const last = output.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  return /^\d+(\.\d+)+$/.test(last) ? last : null;
}
export function parseAuth(tool: Tool, output: string, exitCode: number): Auth {
  if (tool === "claude") {
    try {
      const value = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
      if (typeof value.loggedIn !== "boolean") return { state: "unknown" };
      if (!value.loggedIn) return { state: "signedOut" };
      const method = typeof value.authMethod === "string" ? value.authMethod : "";
      const plan = typeof value.subscriptionType === "string" ? ` (${value.subscriptionType})` : "";
      return { state: "signedIn", how: method === "claude.ai" ? `Claude subscription${plan}` : /api/i.test(method) ? "API key" : method || "signed in" };
    } catch { return { state: "unknown" }; }
  }
  if (exitCode !== 0) return { state: /not logged in/i.test(output) ? "signedOut" : "unknown" };
  const how = output.split(/\r?\n/).find(line => line.includes("Logged in using "))?.split("Logged in using ")[1] ?? "";
  return { state: "signedIn", how: /API key/i.test(how) ? "API key" : /ChatGPT/i.test(how) ? "ChatGPT" : how.trim().split(/\s+/)[0] || "signed in" };
}
const quoted = (path: string) => process.platform === "win32" ? `"${path.replaceAll('"', '""')}"` : `'${path.replaceAll("'", "'\\''")}'`;
export function evaluate(tool: Tool, path: string | null, versionResult: CommandResult | null, auth: Auth, latest: string | null): DoctorCheck {
  const spec = tools[tool];
  const check: DoctorCheck = { tool, name: spec.name, isRequired: tool === "claude", minimum: spec.minimum, status: "ok", version: null, path, auth: null, latest, summary: "", fix: null };
  const install = `npm i -g ${spec.package}@latest`;
  const update = tool === "claude" && path ? `${quoted(path)} update` : install;
  if (!path) return { ...check, status: check.isRequired ? "failing" : "warning", summary: check.isRequired ? "Not found. Bots can't start without it." : "Not found. It is optional.", fix: install };
  if (auth.state === "signedIn") check.auth = auth.how;
  const version = versionResult && !versionResult.timedOut ? cliVersion(versionResult.output) : null;
  if (!version) return { ...check, status: "warning", summary: versionResult?.timedOut ? `Found, but \`${tool} --version\` did not answer in 10 s.` : "Found, but its version could not be read." };
  check.version = version;
  if (compareVersions(version, spec.minimum) < 0) return { ...check, status: "failing", summary: `Version ${version} is older than ${spec.minimum}, ${spec.reason}.`, fix: update };
  const login = `${quoted(path)} ${tool === "claude" ? "auth login" : "login"}`;
  if (auth.state !== "signedIn") return { ...check, status: auth.state === "signedOut" ? "failing" : "warning", summary: auth.state === "signedOut" ? "Not signed in." : "Couldn't tell whether it is signed in.", fix: login };
  check.summary = `Signed in with ${auth.how}.`;
  if (latest && compareVersions(version, latest) < 0) { check.summary += ` ${latest} is available.`; check.fix = update; }
  return check;
}

/** Same environment, override and executable search as the bot heads; never source a shell. */
export function locateExecutable(command: string, env = childEnvironment()): string | null {
  const resolved = resolveExecutable(command, env);
  const candidates = process.platform === "win32" && !isAbsolute(resolved)
    ? (env.PATH ?? "").split(delimiter).filter(isAbsolute).flatMap(folder => ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")].map(ext => join(folder, resolved + ext)))
    : [resolved];
  return candidates.find(path => {
    if (!isAbsolute(path)) return false;
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  }) ?? null;
}
export const runCommand: Run = (path, args, timeout) => new Promise(resolve => {
  const env = childEnvironment({ NO_COLOR: "1" });
  env.PATH = [dirname(path), env.PATH ?? ""].join(delimiter);
  const child = execFile(path, args, { env, timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error && typeof error.code === "string") { resolve(null); return; }
    resolve({ output: stdout + stderr, exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0, timedOut: !!error?.killed });
  });
  child.stdin?.end();
});
export class Doctor {
  constructor(private options: { locate?: (tool: Tool) => string | null; run?: Run; latest?: (name: string) => Promise<string | null>; agy?: () => ReturnType<typeof agyRuntimeStatus> } = {}) {}
  async check(includeLatest: boolean): Promise<DoctorCheck[]> {
    const run = this.options.run ?? runCommand;
    const checks = await Promise.all((["claude", "codex"] as const).map(async tool => {
      const spec = tools[tool];
      const latest = includeLatest ? (this.options.latest ?? (async name => {
        const npm = locateExecutable("npm");
        const result = npm ? await run(npm, ["view", name, "version"], DOCTOR_TIMEOUT_MS) : null;
        return result && !result.timedOut && result.exitCode === 0 ? parseLatest(result.output) : null;
      }))(spec.package).catch(() => null) : Promise.resolve(null);
      const path = this.options.locate ? this.options.locate(tool) : locateExecutable(process.env[tool === "claude" ? "BOTLING_CLAUDE_PATH" : "BOTLING_CODEX_PATH"] ?? tool);
      const [version, auth] = path ? await Promise.all([run(path, ["--version"], DOCTOR_TIMEOUT_MS), run(path, spec.auth, DOCTOR_TIMEOUT_MS)]) : [null, null];
      return evaluate(tool, path, version, auth && !auth.timedOut ? parseAuth(tool, auth.output, auth.exitCode) : { state: "unknown" }, cliVersion(await latest));
    }));
    const agy = this.options.agy?.() ?? agyRuntimeStatus({}, process.cwd());
    checks.push({ tool: 'antigravity', name: 'Antigravity', isRequired: false, minimum: '1.4.3',
      status: agy.valid ? 'ok' : 'warning', version: agy.valid ? '1.4.3' : null, path: agy.effective,
      auth: null, latest: null, summary: agy.message + (agy.override ? " BOTLING_AGY_ACP_PATH is active; remove it and restart Botling to use automatic local installation." : ""), fix: null });
    return checks;
  }
}

export class DoctorModel {
  private state: DoctorView = { checks: [], isRunning: false, checkedAt: null, includedLatest: false, needsAttention: false };
  private pending: Promise<DoctorView> | null = null;
  constructor(private doctor: Pick<Doctor, "check"> = new Doctor(), private changed: (view: DoctorView) => void = () => {}) {}
  view(): DoctorView { return this.state; }
  async run(includeLatest: boolean): Promise<DoctorView> {
    if (this.pending) {
      await this.pending;
      if (includeLatest && !this.state.includedLatest) return this.run(true);
      return this.state;
    }
    this.state = { ...this.state, isRunning: true }; this.changed(this.state);
    this.pending = (async () => {
      try {
        const checks = await this.doctor.check(includeLatest);
        this.state = { checks, isRunning: false, checkedAt: Date.now(), includedLatest: includeLatest, needsAttention: checks.some(check => check.isRequired && check.status === "failing") };
        return this.state;
      } finally {
        this.pending = null;
        this.state = { ...this.state, isRunning: false };
        this.changed(this.state);
      }
    })();
    return this.pending;
  }
}
