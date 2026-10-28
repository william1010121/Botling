import { afterEach, expect, it, vi } from "vitest";
import { UsageBook, usageView } from "../../src/core/usage";
import { tempDir } from "../helpers";
it("fetches provider readings without a bot turn and persists them", async () => {
  const retrieve = vi.fn(async (engine: string) => ({ week: { used: engine === "codex" ? .22 : .12, seen: 815000000, resetsAt: 816000000 } }));
  const dir = tempDir("quota-refresh");
  const book = new UsageBook(dir, undefined, undefined, retrieve);
  await book.refresh();
  expect(usageView(book.view()).codex.week?.used).toBe(.22);
  expect(new UsageBook(dir).claude.week?.used).toBe(.12);
  await book.refresh();
  expect(retrieve).toHaveBeenCalledTimes(2);
});


it("replaces an authoritative snapshot rather than retaining a removed window", async () => {
  const book = new UsageBook(tempDir("quota-replace"), undefined, undefined, async () => ({ week: { used: .2, seen: 20 } }));
  book.note("codex", { fiveHour: { used: .9, seen: 1 } });
  await book.refresh();
  expect(book.codex.fiveHour).toBeUndefined();
});


import { QuotaError, claudeUsageLimits, readClaudeQuota, readCodexQuota } from "../../src/core/quota";
import { UsageView } from "../../src/contract";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
afterEach(() => vi.restoreAllMocks());

it("deduplicates concurrent opens, throttles failures, and retries after a minute", async () => {
  let now = 100000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const retrieve = vi.fn(async () => { await gate; throw new QuotaError("auth_required"); });
  const book = new UsageBook(tempDir("quota-dedup"), undefined, undefined, retrieve);
  const first = book.refresh();
  expect(book.refresh()).toBe(first);
  release(); await first;
  expect(book.quotaStatus).toEqual({ claude: "auth_required", codex: "auth_required" });
  await book.refresh(); expect(retrieve).toHaveBeenCalledTimes(2);
  now += 60000;
  await book.refresh(); expect(retrieve).toHaveBeenCalledTimes(4);
});

it("isolates provider failure and preserves last known readings without claiming refresh success", async () => {
  const book = new UsageBook(tempDir("quota-partial"), undefined, undefined, async engine => {
    if (engine === "claude") throw new QuotaError("auth_required");
    return { week: { used: .22, seen: 20 } };
  });
  book.note("claude", { week: { used: .3, seen: 1 } });
  await book.refresh();
  const view = UsageView.parse(usageView(book.view()));
  expect(view.quotaStatus).toEqual({ claude: "auth_required", codex: "available" });
  expect(view.claude.week?.seen).toBe(978307201000);
  expect(view.codex.week?.used).toBe(.22);
});

it("reports empty responses and sanitized unexpected failures", async () => {
  const book = new UsageBook(tempDir("quota-empty"), undefined, undefined, async engine => {
    if (engine === "claude") throw new Error("private provider detail");
    return {};
  });
  await book.refresh();
  expect(book.quotaStatus).toEqual({ claude: "network_error", codex: "missing" });
  expect(JSON.stringify(usageView(book.view()))).not.toContain("private provider detail");
});

it("parses Claude percentages, zero usage and reset dates without inventing absent windows", () => {
  expect(claudeUsageLimits({ five_hour: { utilization: 0, resets_at: "2026-10-28T00:00:00Z" }, seven_day: { utilization: 42 } }, 10))
    .toEqual({ fiveHour: { used: 0, seen: 10, resetsAt: Date.parse("2026-10-28T00:00:00Z") / 1000 - 978307200 }, week: { used: .42, seen: 10 } });
  expect(claudeUsageLimits({ five_hour: { utilization: "0" }, seven_day: { utilization: 101 } })).toEqual({});
});

it.each([[401, "auth_rejected"], [403, "forbidden"], [500, "network_error"]])("classifies Claude HTTP %s", async (status, expected) => {
  const request = vi.fn(async () => new Response("", { status: Number(status) }));
  await expect(readClaudeQuota({ CLAUDE_CODE_OAUTH_TOKEN: "test-only" }, request as typeof fetch)).rejects.toMatchObject({ status: expected });
  expect(request).toHaveBeenCalledTimes(1);
});

it("handles Claude success, malformed JSON, empty payload, and timeout", async () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "test-only" };
  const response = (body: string) => vi.fn(async () => new Response(body)) as typeof fetch;
  expect((await readClaudeQuota(env, response('{"seven_day":{"utilization":22}}'))).week?.used).toBe(.22);
  await expect(readClaudeQuota(env, response("bad"))).rejects.toMatchObject({ status: "invalid_response" });
  await expect(readClaudeQuota(env, response("{}"))).rejects.toMatchObject({ status: "missing" });
  await expect(readClaudeQuota(env, vi.fn(async () => { throw new DOMException("timeout", "TimeoutError"); }) as typeof fetch)).rejects.toMatchObject({ status: "timeout" });
});

it.each(["success", "auth", "malformed", "empty"])("Codex protocol round trip: %s", async mode => {
  const dir = tempDir("quota-cli");
  const file = join(dir, "codex");
  writeFileSync(file, `#!${process.execPath}
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => {
 const m = JSON.parse(line);
 if(m.method === 'initialize') console.log(JSON.stringify({id:m.id,result:{}}));
 else if(m.method === 'account/rateLimits/read') {
  const mode = ${JSON.stringify(mode)};
  if(mode === 'malformed') console.log('bad');
  else console.log(JSON.stringify({id:m.id,...(mode === 'auth' ? {error:{message:'401 login required'}} : {result:{rateLimitsByLimitId:{codex: mode === 'empty' ? {} : {secondary:{usedPercent:22,windowDurationMins:10080}}}}})}));
 }
});
`, { mode: 0o755 });
  const result = readCodexQuota({ ...process.env, BOTLING_CODEX_PATH: file });
  if(mode === "success") expect((await result).week?.used).toBe(.22);
  else await expect(result).rejects.toMatchObject({ status: mode === "auth" ? "auth_required" : mode === "empty" ? "missing" : "invalid_response" });
});

it("reports missing Codex executable without launching a login", async () => {
  await expect(readCodexQuota({ BOTLING_CODEX_PATH: join(tempDir("quota-no-cli"), "absent") })).rejects.toMatchObject({ status: "cli_unavailable" });
});

// Synthetic file credentials only: never consult the real home directory or Keychain.
function claudeFixture(expiresAt?: unknown) {
  const dir = tempDir("quota-expiry");
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "fixture-only-token", expiresAt },
  }));
  return { CLAUDE_CONFIG_DIR: dir };
}

it.each([1e11, 1793145599999, 1793145600000])("rejects known expired Claude token %s before any request", async expiresAt => {
  vi.spyOn(Date, "now").mockReturnValue(1793145600000);
  const request = vi.fn(async () => new Response('{"seven_day":{"utilization":22}}'));
  const env = claudeFixture(expiresAt);
  await expect(readClaudeQuota(env, request as typeof fetch)).rejects.toMatchObject({ status: "token_expired", message: "token_expired" });
  expect(request).not.toHaveBeenCalled();
  const book = new UsageBook(tempDir("quota-expired-view"), undefined, undefined, async engine => {
    if (engine === "claude") return readClaudeQuota(env, request as typeof fetch);
    return { week: { used: .2, seen: 20 } };
  });
  await book.refresh();
  expect(UsageView.parse(usageView(book.view())).quotaStatus?.claude).toBe("token_expired");
  expect(request).not.toHaveBeenCalled();
});

it("uses an unexpired Claude token normally and reports 401 as rejection with unknown cause", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1793145600000);
  const env = claudeFixture(1793145600001);
  const request = vi.fn(async () => new Response('{"seven_day":{"utilization":22}}'));
  expect((await readClaudeQuota(env, request as typeof fetch)).week?.used).toBe(.22);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]).toEqual([
    "https://api.anthropic.com/api/oauth/usage",
    expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
  ]);
  const rejected = vi.fn(async () => new Response("", { status: 401 }));
  const book = new UsageBook(tempDir("quota-rejected-view"), undefined, undefined, async engine => {
    if (engine === "claude") return readClaudeQuota(env, rejected as typeof fetch);
    return { week: { used: .2, seen: 20 } };
  });
  await book.refresh();
  expect(UsageView.parse(usageView(book.view())).quotaStatus?.claude).toBe("auth_rejected");
  expect(rejected).toHaveBeenCalledTimes(1);
});

it.each([undefined, null, "1793145599999", "invalid", -1, 0, 1.5, 1793145599, 1793145601, 1e11 - 1, {}, [], 1e100])("keeps unknown/malformed Claude expiry %j compatible", async expiresAt => {
  vi.spyOn(Date, "now").mockReturnValue(1793145600000);
  const request = vi.fn(async () => new Response('{"seven_day":{"utilization":22}}'));
  expect((await readClaudeQuota(claudeFixture(expiresAt), request as typeof fetch)).week?.used).toBe(.22);
  expect(request).toHaveBeenCalledTimes(1);
});
