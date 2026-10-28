// Read-only provider quota probes. Never start a model turn, refresh tokens, or log credentials.
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { executableEnvironment, resolveExecutable } from "./process/executable";
import { codexRateLimits, isEmptyLimits, type RateLimits } from "./usage";
import { toSwiftDate } from "./store/records";

export type QuotaStatus = "available" | "missing" | "auth_required" | "token_expired" | "auth_rejected" | "forbidden" | "timeout" | "network_error" | "invalid_response" | "cli_unavailable";
export class QuotaError extends Error { constructor(readonly status: QuotaStatus) { super(status); } }
export type QuotaRetriever = (engine: "claude" | "codex") => Promise<RateLimits>;

export function claudeUsageLimits(value: any, seen = toSwiftDate()): RateLimits {
  const limits: RateLimits = {};
  for (const [key, target] of [["five_hour", "fiveHour"], ["seven_day", "week"]] as const) {
    const entry = value?.[key];
    if (typeof entry?.utilization !== "number" || !Number.isFinite(entry.utilization) || entry.utilization < 0 || entry.utilization > 100) continue;
    const reset = typeof entry.resets_at === "string" ? Date.parse(entry.resets_at) : NaN;
    limits[target] = { used: entry.utilization / 100, seen, ...(Number.isFinite(reset) ? { resetsAt: reset / 1000 - 978307200 } : {}) };
  }
  return limits;
}

async function claudeToken(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return env.CLAUDE_CODE_OAUTH_TOKEN;
  let raw: string;
  try {
    if (process.platform === "darwin" && !env.CLAUDE_CONFIG_DIR) {
      raw = await new Promise<string>((resolve, reject) => execFile("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 2000, maxBuffer: 128 * 1024 }, (error, stdout) => error ? reject(new QuotaError("auth_required")) : resolve(stdout)));
    } else raw = await readFile(join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), ".credentials.json"), "utf8");
    const credentials = JSON.parse(raw)?.claudeAiOauth;
    const token = credentials?.accessToken;
    if (typeof token !== "string" || !token) throw new Error();
    // expiresAt is epoch milliseconds. Unknown/malformed expiry is not evidence of expiration.
    const expiresAt = credentials?.expiresAt;
    if (typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt >= 0 && expiresAt <= Date.now()) {
      throw new QuotaError("token_expired");
    }
    return token;
  } catch (error) {
    if (error instanceof QuotaError) throw error;
    throw new QuotaError("auth_required");
  }
}

export async function readClaudeQuota(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): Promise<RateLimits> {
  const token = await claudeToken(env);
  try {
    const response = await request("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, signal: AbortSignal.timeout(6000), redirect: "error",
    });
    if (!response.ok) throw new QuotaError(response.status === 401 ? "auth_rejected" : response.status === 403 ? "forbidden" : "network_error");
    let value: unknown;
    try { value = await response.json(); } catch { throw new QuotaError("invalid_response"); }
    const limits = claudeUsageLimits(value);
    if (isEmptyLimits(limits)) throw new QuotaError("missing");
    return limits;
  } catch (error) {
    if (error instanceof QuotaError) throw error;
    throw new QuotaError(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "timeout" : "network_error");
  }
}

export function readCodexQuota(env: NodeJS.ProcessEnv = process.env): Promise<RateLimits> {
  return new Promise((resolve, reject) => {
    const launchEnv = executableEnvironment(Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
    const child = spawn(resolveExecutable(env.BOTLING_CODEX_PATH ?? "codex", launchEnv), ["app-server"], { env: launchEnv, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    let done = false, bytes = 0;
    const finish = (error?: QuotaError, limits?: RateLimits) => {
      if (done) return;
      done = true;
      clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
      const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 500); kill.unref();
      if (error) reject(error); else resolve(limits!);
    };
    const timer = setTimeout(() => finish(new QuotaError("timeout")), 8000);
    child.on("error", () => finish(new QuotaError("cli_unavailable")));
    child.on("exit", () => finish(new QuotaError("cli_unavailable")));
    child.stdin.on("error", () => finish(new QuotaError("cli_unavailable")));
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) finish(new QuotaError("invalid_response")); });
    lines.on("line", line => {
      if (done) return;
      let message: any;
      try { message = JSON.parse(line); } catch { finish(new QuotaError("invalid_response")); return; }
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error) {
        // Only classify the error in memory; provider text can contain private account details.
        const auth = /auth|login|log in|sign in|unauthorized|401/i.test(String(message.error.message));
        finish(new QuotaError(auth ? "auth_required" : "invalid_response")); return;
      }
      if (message.id === 1) { send({ method: "initialized" }); send({ id: 2, method: "account/rateLimits/read", params: {} }); }
      else {
        const snapshot = message.result?.rateLimitsByLimitId?.codex ?? message.result?.rateLimits;
        const limits = codexRateLimits(snapshot);
        finish(isEmptyLimits(limits) ? new QuotaError("missing") : undefined, limits);
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "botling_quota", version: "1" } } });
  });
}

export const retrieveQuota: QuotaRetriever = engine => engine === "claude" ? readClaudeQuota() : readCodexQuota();
