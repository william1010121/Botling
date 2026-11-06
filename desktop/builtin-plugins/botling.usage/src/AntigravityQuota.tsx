import type { AntigravityQuota as AntigravityQuotaView } from "../../../../Web/host/src/api";
import { QuotaCard } from "./QuotaCard";
import { asOf, STALE_AFTER_MS, type LimitWindow } from "./usage-text";

type Bucket = Extract<AntigravityQuotaView, { status: "available" }>["buckets"][number];
/** Only Gemini's own groups are shown (not the "Claude & GPT" ones). */
export const isGemini = (bucket: Bucket) => /gemini/i.test(bucket.group);
const isWeekly = (bucket: Bucket) => /week/i.test(bucket.label);
/** The ring's name, in the provider's own words: its model group and window ("Gemini 5-hour", "Gemini Argon Weekly"). */
export const bucketTitle = (bucket: Bucket) => bucket.label.toLowerCase().includes(bucket.group.toLowerCase()) ? bucket.label : `${bucket.group} ${bucket.label}`;
/** The Gemini buckets to draw, shorter window first (a 5-hour window before the week), else in the provider's order. */
export function geminiBuckets(buckets: readonly Bucket[]): Bucket[] {
  return buckets.map((bucket, index) => ({ bucket, index })).filter(({ bucket }) => isGemini(bucket))
    .sort((a, b) => Number(isWeekly(a.bucket)) - Number(isWeekly(b.bucket)) || a.index - b.index).map(({ bucket }) => bucket);
}
/** The provider reports what is LEFT; the rings (like Claude's and Codex's) show what is USED. */
export function usedWindow(bucket: Bucket | undefined, seen: number): LimitWindow | null {
  if (!bucket || bucket.disabled || bucket.remainingFraction === undefined) return null;
  return { used: Math.min(1, Math.max(0, 1 - bucket.remainingFraction)), resetsAt: bucket.resetsAt ?? null, seen };
}
const noReading = (bucket: Bucket) => bucket.disabled ? "disabled" : bucket.remainingAmount !== undefined ? `${bucket.remainingAmount} units left` : "not reported";

/** Why there is no reading, in one line. */
function reason(quota: AntigravityQuotaView | undefined, loading: boolean): string {
  if (!quota) return loading ? "Loading quota…" : "";
  if (quota.status === "available") return "";
  if (quota.status === "error") return "Quota refresh failed";
  switch (quota.reason) {
    case "busy": return "Antigravity is busy";
    case "no_connection": return "Connect Antigravity to read quota";
    case "unsupported_connection": return "Sign in to Antigravity again in a Botling chat to read quota";
    case "missing_data": return "Google reported no Gemini quota";
    default: return "Quota readings unavailable";
  }
}

/** Provider-defined Gemini model groups and windows, one ring card each; never inferred from tokens. The last reading is
 * kept (or one empty "Gemini" card shown) while Antigravity is busy, the read failed, or nothing was read yet. */
export function AntigravityQuota({ quota, loading = false, failed = false, onRetry, now = Date.now() }: {
  quota?: AntigravityQuotaView; loading?: boolean; failed?: boolean; onRetry?: () => void; now?: number;
}) {
  const busy = quota?.status === "unavailable" && quota.reason === "busy";
  const errored = failed || quota?.status === "error";
  const reading = quota?.status === "available" ? quota : quota?.status === "unavailable" ? quota.lastKnown : undefined;
  const gemini = reading ? geminiBuckets(reading.buckets) : [];
  const stale = !!reading && now - reading.seen >= STALE_AFTER_MS;
  const problem = errored ? "Quota refresh failed" : reason(quota, loading) || (reading && !gemini.length ? "Google reported no Gemini quota" : "");
  const kept = !!reading && gemini.length > 0 && (!!problem || stale);
  const parts = [kept && reading ? `Updated ${asOf(reading.seen, now).replace(/^as of /, "")}` : "", problem].filter(Boolean);
  const retryable = !!onRetry && (loading || busy || errored || quota?.status === "unavailable" || quota?.status === "error");
  return <div role="group" aria-label="Antigravity quota" aria-live="polite">
    <div className={gemini.length > 1 ? "quick-usage-cards" : "quick-usage-cards single"}>
      {gemini.length
        ? gemini.map((bucket, index) => <QuotaCard key={`${index}:${bucket.group}:${bucket.label}`} engine="Antigravity" title={bucketTitle(bucket)} now={now}
          weekly={isWeekly(bucket)} window={usedWindow(bucket, reading!.seen)} lastKnown={kept} unavailable={noReading(bucket)} />)
        : <QuotaCard engine="Antigravity" title="Gemini" now={now} window={null} unavailable={reading ? "not reported" : "not read yet"} />}
    </div>
    {(parts.length > 0 || retryable) && <p className="quick-usage-note">{parts.join(" · ")}
      {retryable && <span className="quick-usage-retry">{parts.length > 0 ? " · " : ""}<button type="button" disabled={loading} onClick={onRetry}>Retry quota</button></span>}</p>}
  </div>;
}
