import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AntigravityQuotaView } from "../contract";
import { quotaError, quotaUnavailable } from "./antigravity-quota";

/**
 * Antigravity's quota, asked of Google's cloudcode-pa API (`retrieveUserQuotaSummary`, the call agy's own /usage makes)
 * with the sign-in agy already has, so no chat turn is spent on it. Ported from T3 Code's antigravityUsageLimits.
 *
 * The sign-in is read only from agy's file store, `<GEMINI_HOME>/antigravity-acp/acp_token.json`. On macOS agy keeps it in
 * the Keychain (service "gemini") unless AGY_ACP_FORCE_FILE_STORAGE is set, which Botling sets for its own agy profiles
 * (agySignInEnv); Botling never reads the Keychain, which would ask the user, so without the file the quota is unknown. Read only: a token is refreshed in memory and never
 * written back, logged or put in an error. Every failure is quiet and becomes "unavailable"/"error".
 */

type Bucket = Extract<AntigravityQuotaView, { status: "available" }>["buckets"][number];
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: "manual"; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const ENDPOINTS = ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** How long a reading is reused. */
export const AGY_QUOTA_TTL_MS = 5 * 60_000;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A summary's buckets as Botling shows them: a family (Gemini, Claude & GPT…) and its window. */
export function summaryBuckets(summary: unknown, requestedAt: number): Bucket[] {
  const root = obj(summary);
  const groups = Array.isArray(root.groups) && root.groups.some(g => Array.isArray(obj(g).buckets) && (obj(g).buckets as unknown[]).length)
    ? (root.groups as unknown[]) : [{ buckets: root.buckets }];
  const out = new Map<string, Bucket>();
  for (const rawGroup of groups) {
    const group = obj(rawGroup);
    for (const raw of Array.isArray(group.buckets) ? group.buckets : []) {
      const bucket = obj(raw), id = str(bucket.bucketId);
      if (!id) continue;
      const groupName = str(group.displayName)?.trim();
      const family = id.startsWith("gemini-argon-") ? groupName || "Gemini Argon" : id.startsWith("gemini-") ? "Gemini" : id.startsWith("3p-") ? "Claude & GPT (shared)" : groupName || id;
      const window = str(bucket.window), mins = window === "5h" ? 300 : window === "weekly" ? 7 * 24 * 60 : undefined;
      const entry: Bucket = { group: family, label: window === "weekly" ? "Weekly" : window === "5h" ? "5-hour" : str(bucket.displayName)?.trim() || "Quota" };
      if (bucket.disabled === true) entry.disabled = true;
      else {
        const fraction = bucket.remainingFraction;
        if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
        entry.remainingFraction = Math.max(0, Math.min(1, fraction));
        const reset = Date.parse(str(bucket.resetTime) ?? "");
        // An untouched bucket reports a rolling full-window reset: no real reset time.
        const untouched = fraction === 1 && bucket.description === undefined && mins !== undefined && Math.abs(reset - requestedAt - mins * 60_000) <= 60_000;
        if (Number.isFinite(reset) && !untouched) entry.resetsAt = reset;
      }
      out.set(id, entry);
    }
  }
  return [...out.values()];
}

/** Older accounts answer only `fetchAvailableModels`, with per-model quotas and no window length. */
export function modelBuckets(response: unknown): Bucket[] {
  const out = new Map<string, Bucket>();
  for (const [id, raw] of Object.entries(obj(obj(response).models))) {
    const model = obj(raw), provider = str(model.modelProvider);
    const family = provider === "MODEL_PROVIDER_GOOGLE" || id.startsWith("gemini-") ? "Gemini" : provider === "MODEL_PROVIDER_ANTHROPIC" || id.startsWith("claude-") ? "Claude" : provider === "MODEL_PROVIDER_OPENAI" || id.startsWith("gpt-") ? "GPT" : undefined;
    if (!family) continue;
    for (const [suffix, info] of [["Reported quota", model.quotaInfo], ["Weekly", model.weeklyQuotaInfo]] as const) {
      const quota = obj(info), fraction = quota.remainingFraction;
      if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
      const entry: Bucket = { group: family, label: suffix, remainingFraction: Math.max(0, Math.min(1, fraction)) };
      const reset = Date.parse(str(quota.resetTime) ?? "");
      if (Number.isFinite(reset)) entry.resetsAt = reset;
      const key = `${family}:${suffix}`, previous = out.get(key);
      if (!previous || entry.remainingFraction! < previous.remainingFraction!) out.set(key, entry);
    }
  }
  return [...out.values()];
}

const lessLeft = (a: Bucket, b: Bucket) => (a.remainingFraction ?? 1) < (b.remainingFraction ?? 1);

/** agy's file store for the consumer sign-in (agy_acp_server 1.4.3: `os.path.join(acp_dir(), "acp_token.json")`). */
export const agyTokenFile = (home: string) => join(home, "antigravity-acp", "acp_token.json");
const mtime = (file: string) => { try { return statSync(file).mtimeMs; } catch { return -1; } };

/** The agy-acp root above a profile (`<dataDir>/agy-acp/<id>`, a worker's `<…>/<id>/workers/<worker>`), else its parent. */
function profilesRoot(home: string) {
  for (let at = dirname(home); at !== dirname(at); at = dirname(at)) if (basename(at) === "agy-acp") return at;
  return dirname(home);
}
/** Every Botling agy profile's sign-in file under a root that exists, newest first. */
function tokenFiles(root: string) {
  const out: { file: string; at: number }[] = [];
  const add = (home: string) => { const file = agyTokenFile(home), at = mtime(file); if (at >= 0) out.push({ file, at }); };
  let profiles: string[] = [];
  try { profiles = readdirSync(root); } catch { /* none yet */ }
  for (const profile of profiles) {
    add(join(root, profile));
    let workers: string[] = [];
    try { workers = readdirSync(join(root, profile, "workers")); } catch { /* no workers */ }
    for (const worker of workers) add(join(root, profile, "workers", worker));
  }
  return out.sort((a, b) => b.at - a.at);
}

/** The single profile allowed to start without a sign-in file in file mode (agy then opens the browser to sign in). */
let signingIn: string | null = null;
/**
 * The environment Botling's own agy process for a profile (GEMINI_HOME) gets so its sign-in is a file Botling can read.
 * A profile without the file is given the newest one another Botling profile has (one sign-in serves every bot). When
 * there is none yet, one profile at a time is put in file mode, where agy signs in through the browser; the others keep
 * agy's default (the Keychain sign-in they share), so a start of many bots does not open many sign-in pages.
 * `release` ends that one's turn (call when its process ends).
 */
export function agySignInEnv(home: string): { env: Record<string, string>; release: () => void } {
  const force = { AGY_ACP_FORCE_FILE_STORAGE: "1" }, none = () => {};
  const own = agyTokenFile(home);
  if (mtime(own) >= 0) return { env: force, release: none };
  const newest = tokenFiles(profilesRoot(home))[0];
  if (newest) {
    try {
      const temp = `${own}.botling-${process.pid}.tmp`;
      copyFileSync(newest.file, temp); chmodSync(temp, 0o600); renameSync(temp, own);
      return { env: force, release: none };
    } catch { /* fall through */ }
  }
  if (signingIn !== null && signingIn !== home) return { env: {}, release: none };
  signingIn = home;
  return { env: force, release: () => { if (signingIn === home) signingIn = null; } };
}

interface Token { clientId: string; clientSecret: string; refreshToken: string; project?: string }
function readToken(home: string): Token | null {
  try {
    const raw = obj(JSON.parse(readFileSync(agyTokenFile(home), "utf8")));
    const clientId = str(raw.client_id), clientSecret = str(raw.client_secret), refreshToken = str(raw.refresh_token);
    if (!clientId || !clientSecret || !refreshToken) return null;
    return { clientId, clientSecret, refreshToken, ...(str(raw.project_id) ? { project: str(raw.project_id) } : {}) };
  } catch { return null; }
}

const access = new Map<string, { access: string; expiresAt: number }>();
const readings = new Map<string, { at: number; value: AntigravityQuotaView }>();
const pending = new Map<string, Promise<AntigravityQuotaView>>();

/** Forget cached tokens and readings (tests). */
export function resetAgyQuotaCache() { access.clear(); readings.clear(); pending.clear(); signingIn = null; }

export interface AgyQuotaOptions { fetch?: Fetch; now?: () => number; platform?: string; arch?: string }

/** The quota of the account signed in to agy in this profile (GEMINI_HOME), reused for five minutes. */
export function readAgyQuota(home: string, options: AgyQuotaOptions = {}): Promise<AntigravityQuotaView> {
  const now = options.now ?? Date.now;
  const token = readToken(home);
  if (!token) return Promise.resolve(quotaUnavailable("unsupported_connection"));
  const id = createHash("sha256").update(`${token.clientId}\0${token.refreshToken}\0${token.project ?? ""}`).digest("hex");
  const hit = readings.get(id);
  if (hit && now() - hit.at < AGY_QUOTA_TTL_MS) return Promise.resolve(hit.value);
  const running = pending.get(id);
  if (running) return running;
  const promise = ask(id, token, options, now).catch(() => quotaError()).then(value => {
    readings.set(id, { at: now(), value });
    return value;
  }).finally(() => pending.delete(id));
  pending.set(id, promise);
  return promise;
}

async function ask(id: string, token: Token, options: AgyQuotaOptions, now: () => number): Promise<AntigravityQuotaView> {
  const fetcher: Fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  const post = async (url: string, headers: Record<string, string>, body: string) => {
    const response = await fetcher(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("request failed");
    return response.json();
  };
  let bearer = access.get(id);
  if (!bearer || bearer.expiresAt <= now() + 60_000) {
    const body = new URLSearchParams({ client_id: token.clientId, client_secret: token.clientSecret, refresh_token: token.refreshToken, grant_type: "refresh_token" }).toString();
    const refreshed = obj(await post(TOKEN_URL, { "Content-Type": "application/x-www-form-urlencoded" }, body));
    const value = str(refreshed.access_token), expires = refreshed.expires_in;
    if (!value || typeof expires !== "number" || !(expires > 0)) return quotaError("invalid_response");
    access.set(id, bearer = { access: value, expiresAt: now() + expires * 1000 });
  }
  const headers = {
    Authorization: `Bearer ${bearer.access}`, "Content-Type": "application/json",
    "User-Agent": `antigravity/hub/2.24.0 (aidev_client; os_type=${options.platform ?? process.platform}; arch=${options.arch ?? process.arch}; cl=963137146)`,
  };
  const body = JSON.stringify(token.project ? { project: token.project } : {});
  // The endpoints report different groups: merge them, keeping each bucket's most-used reading.
  const merged = async (operation: string, parse: (response: unknown, at: number) => Bucket[]) => {
    const all = await Promise.all(ENDPOINTS.map(async endpoint => {
      const at = now();
      try { return parse(await post(`${endpoint}/v1internal:${operation}`, headers, body), at); } catch { return []; }
    }));
    const out = new Map<string, Bucket>();
    for (const bucket of all.flat()) {
      const key = `${bucket.group}\0${bucket.label}`, previous = out.get(key);
      if (!previous || lessLeft(bucket, previous)) out.set(key, bucket);
    }
    return [...out.values()];
  };
  let buckets = await merged("retrieveUserQuotaSummary", summaryBuckets);
  if (!buckets.length) buckets = await merged("fetchAvailableModels", modelBuckets);
  return buckets.length ? { status: "available", source: "antigravity_acp", seen: now(), buckets } : quotaUnavailable("missing_data");
}

/** The quota from the Botling agy profile (`<dataDir>/agy-acp/<profile>`) whose sign-in file changed last. */
export function readAgyQuotaInProfiles(dataDir: string, options: AgyQuotaOptions = {}): Promise<AntigravityQuotaView> {
  const root = join(dataDir, "agy-acp");
  let best: { home: string; mtime: number } | null = null, profiles: string[];
  try { profiles = readdirSync(root); } catch { return Promise.resolve(quotaUnavailable()); }
  for (const profile of profiles) {
    const home = join(root, profile);
    const at = mtime(agyTokenFile(home)); if (at >= 0 && (!best || at > best.mtime)) best = { home, mtime: at };
  }
  return best ? readAgyQuota(best.home, options) : Promise.resolve(quotaUnavailable("unsupported_connection"));
}
