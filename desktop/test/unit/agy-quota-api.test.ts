import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AntigravityQuotaView } from "../../src/contract";
import { AGY_QUOTA_TTL_MS, modelBuckets, readAgyQuota, readAgyQuotaInProfiles, resetAgyQuotaCache, summaryBuckets } from "../../src/core/agy-quota-api";
import { refreshAntigravityQuota } from "../../src/core/antigravity-quota";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "agy-quota-")); dirs.push(dir); return dir; };
beforeEach(() => resetAgyQuotaCache());
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const SECRET = "refresh-SECRET-1", ACCESS = "access-SECRET-2";
function profile(home: string, token: Record<string, string> = { client_id: "cid", client_secret: "csecret", refresh_token: SECRET, project_id: "proj-1" }) {
  mkdirSync(join(home, "antigravity-acp"), { recursive: true });
  writeFileSync(join(home, "antigravity-acp", "acp_token.json"), JSON.stringify(token));
  return home;
}
const summary = (fraction: number) => ({
  groups: [
    { displayName: "Gemini models", buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: fraction, resetTime: "2026-11-10T00:00:00Z" }, { bucketId: "gemini-5h", window: "5h", remainingFraction: 1, resetTime: "2026-11-06T05:00:00Z", description: "x" }] },
    { displayName: "Other", buckets: [{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.5 }, { bucketId: "argon-off", disabled: true }] },
  ],
});
function fakeFetch(answer: (url: string, body: string) => unknown) {
  return vi.fn(async (url: string, init: { headers: Record<string, string>; body: string; redirect: string }) => {
    expect(init.redirect).toBe("manual");
    if (url.includes("oauth2")) { expect(init.body).toContain(`refresh_token=${SECRET}`); return { ok: true, json: async () => ({ access_token: ACCESS, expires_in: 3600 }) }; }
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS}`);
    const value = answer(url, init.body);
    return value === undefined ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => value };
  });
}

it("asks retrieveUserQuotaSummary with agy's sign-in and maps its buckets", async () => {
  const home = profile(temp());
  const fetch = fakeFetch((url, body) => { expect(JSON.parse(body)).toEqual({ project: "proj-1" }); return url.includes(":retrieveUserQuotaSummary") ? summary(0.75) : undefined; });
  const quota = await readAgyQuota(home, { fetch, now: () => Date.parse("2026-11-06T00:00:00Z") });
  expect(AntigravityQuotaView.parse(quota)).toEqual(quota);
  expect(quota).toMatchObject({ status: "available", source: "antigravity_acp", buckets: [
    { group: "Gemini", label: "Weekly", remainingFraction: 0.75, resetsAt: Date.parse("2026-11-10T00:00:00Z") },
    { group: "Gemini", label: "5-hour", remainingFraction: 1, resetsAt: Date.parse("2026-11-06T05:00:00Z") },
    { group: "Claude & GPT (shared)", label: "Weekly", remainingFraction: 0.5 },
    { group: "Other", label: "Quota", disabled: true },
  ] });
  // Both endpoints asked, the token refreshed once.
  expect(fetch.mock.calls.filter(([url]) => url.includes("retrieveUserQuotaSummary"))).toHaveLength(2);
  expect(fetch.mock.calls.filter(([url]) => url.includes("oauth2"))).toHaveLength(1);
  expect(JSON.stringify(quota)).not.toMatch(/SECRET/);
});

it("reuses a reading for five minutes, then asks again with the cached access token", async () => {
  const home = profile(temp());
  let now = 1_000_000, fraction = 0.9;
  const fetch = fakeFetch(url => url.includes(":retrieveUserQuotaSummary") ? summary(fraction) : undefined);
  const first = await readAgyQuota(home, { fetch, now: () => now });
  fraction = 0.2; now += AGY_QUOTA_TTL_MS - 1;
  expect(await readAgyQuota(home, { fetch, now: () => now })).toBe(first);
  expect(fetch).toHaveBeenCalledTimes(3);
  now += 2;
  const next = await readAgyQuota(home, { fetch, now: () => now });
  expect(next.status === "available" && next.buckets[0].remainingFraction).toBe(0.2);
  expect(fetch.mock.calls.filter(([url]) => url.includes("oauth2"))).toHaveLength(1);
  // Concurrent reads share one request.
  resetAgyQuotaCache();
  const [a, b] = [readAgyQuota(home, { fetch, now: () => now }), readAgyQuota(home, { fetch, now: () => now })];
  expect(a).toBe(b); await a;
});

it("falls back to fetchAvailableModels, and fails quietly to unknown", async () => {
  const home = profile(temp());
  const models = { models: { "gemini-3-pro": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.4 } }, "claude-x": { weeklyQuotaInfo: { remainingFraction: 0.1, resetTime: "2026-11-09T00:00:00Z" } }, other: { quotaInfo: { remainingFraction: 0 } } } };
  const quota = await readAgyQuota(home, { fetch: fakeFetch(url => url.includes("fetchAvailableModels") ? models : { groups: [] }) });
  expect(quota).toMatchObject({ status: "available", buckets: [{ group: "Gemini", label: "Reported quota", remainingFraction: 0.4 }, { group: "Claude", label: "Weekly", remainingFraction: 0.1 }] });
  resetAgyQuotaCache();
  expect(await readAgyQuota(home, { fetch: fakeFetch(() => undefined) })).toEqual({ status: "unavailable", reason: "missing_data", source: "antigravity_acp" });
  resetAgyQuotaCache();
  const offline = await readAgyQuota(home, { fetch: vi.fn(async () => { throw new Error(`network down ${SECRET}`); }) });
  expect(offline).toEqual({ status: "error", reason: "request_failed", source: "antigravity_acp" });
  resetAgyQuotaCache();
  const refused = await readAgyQuota(home, { fetch: vi.fn(async () => ({ ok: false, json: async () => ({ error: SECRET }) })) });
  expect(refused.status).toBe("error");
  expect(JSON.stringify([offline, refused])).not.toMatch(/SECRET/);
});

it("is unknown without agy's file sign-in (a Keychain sign-in is never read)", async () => {
  const fetch = vi.fn();
  expect(await readAgyQuota(temp(), { fetch })).toEqual({ status: "unavailable", reason: "unsupported_connection", source: "antigravity_acp" });
  expect(await readAgyQuota(profile(temp(), { client_id: "only" }), { fetch })).toMatchObject({ reason: "unsupported_connection" });
  expect(fetch).not.toHaveBeenCalled();
  // No agy profile at all: no connection; profiles signed in only through the Keychain: unsupported.
  expect(await refreshAntigravityQuota(temp())).toMatchObject({ status: "unavailable", reason: "no_connection" });
  const data = temp(); mkdirSync(join(data, "agy-acp", "keychain-profile", "antigravity-acp"), { recursive: true });
  expect(await refreshAntigravityQuota(data)).toMatchObject({ status: "unavailable", reason: "unsupported_connection" });
});

it("picks the profile signed in last for a core with no agy connection", async () => {
  const data = temp();
  profile(join(data, "agy-acp", "a"));
  const fetch = fakeFetch(url => url.includes(":retrieveUserQuotaSummary") ? summary(0.33) : undefined);
  const quota = await readAgyQuotaInProfiles(data, { fetch });
  expect(quota.status === "available" && quota.buckets[0].remainingFraction).toBe(0.33);
});

it("keeps an untouched bucket's rolling reset out, and ignores malformed buckets", () => {
  const at = Date.parse("2026-11-06T00:00:00Z");
  expect(summaryBuckets({ buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 1, resetTime: "2026-11-06T05:00:00Z" }, { bucketId: "x" }, { remainingFraction: 1 }] }, at))
    .toEqual([{ group: "Gemini", label: "5-hour", remainingFraction: 1 }]);
  expect(summaryBuckets(null, at)).toEqual([]);
  expect(modelBuckets({ models: { "gemini-a": { quotaInfo: { remainingFraction: 2 } } } })).toEqual([{ group: "Gemini", label: "Reported quota", remainingFraction: 1 }]);
});
