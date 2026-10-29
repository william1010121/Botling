import type { AntigravityQuotaView } from "../contract";
import { QuotaCard } from "./QuotaCard";
import { asOf, STALE_AFTER_MS, type LimitWindow } from "./usage-text";

type Bucket = Extract<AntigravityQuotaView, { status: "available" }>["buckets"][number];
/** Only Gemini's own groups are shown (not the "Claude and GPT models" rows). */
const isGemini = (bucket: Bucket) => /gemini/i.test(bucket.group);
const isFiveHour = (bucket: Bucket) => /(five|5)[\s-]*hours?/i.test(bucket.label);
const isWeek = (bucket: Bucket) => /week/i.test(bucket.label);
/** The provider reports what is LEFT; the rings (like Claude's and Codex's) show what is USED. */
export function usedWindow(bucket: Bucket | undefined, seen: number): LimitWindow | null {
  if (!bucket || bucket.disabled || bucket.remainingFraction === undefined) return null;
  return { used: Math.min(1, Math.max(0, 1 - bucket.remainingFraction)), resetsAt: bucket.resetsAt ?? null, seen };
}
const noReading = (bucket: Bucket | undefined) => !bucket ? "unavailable" : bucket.disabled ? "disabled"
  : bucket.remainingAmount !== undefined ? `${bucket.remainingAmount} units left` : "not reported";

/** Provider-defined model groups and windows; never inferred from tokens. Always the same two ring cards as Claude and Codex,
 * with the last reading kept (or an empty shell) while Antigravity is busy, the read failed, or nothing was read yet. */
export function AntigravityQuota({ quota, loading = false, failed = false, onRetry, now = Date.now() }: {
  quota?: AntigravityQuotaView; loading?: boolean; failed?: boolean; onRetry?: () => void; now?: number;
}) {
  const busy = quota?.status === "unavailable" && quota.reason === "busy";
  const errored = failed || quota?.status === "error";
  const reading = quota?.status === "available" ? quota : quota?.status === "unavailable" ? quota.lastKnown : undefined;
  const gemini = reading?.buckets.filter(isGemini) ?? [];
  const five = gemini.find(isFiveHour), week = gemini.find(isWeek);
  const cards: [string, Bucket | undefined, boolean][] = [["5 hours", five, false], ["Week", week, true]];
  const stale = !!reading && now - reading.seen >= STALE_AFTER_MS;
  const problem = errored ? "Quota refresh failed"
    : busy ? "Antigravity is busy"
    : quota?.status === "unavailable" && quota.reason === "no_connection" ? "Connect Antigravity to read quota"
    : !quota && loading ? "Loading quota…"
    : quota?.status === "unavailable" ? "Quota readings unavailable" : "";
  const kept = !!reading && (!!problem || stale);
  const parts = [kept && reading ? `Updated ${asOf(reading.seen, now).replace(/^as of /, "")}` : "", problem].filter(Boolean);
  const retryable = !!onRetry && (loading || busy || errored || quota?.status === "unavailable" || quota?.status === "error");
  return <div role="group" aria-label="Antigravity quota" aria-live="polite">
    <div className="quick-usage-cards">
      {cards.map(([title, bucket, weekly]) => <QuotaCard key={title} engine="Antigravity Gemini" title={title} now={now} weekly={weekly}
        window={usedWindow(bucket, reading?.seen ?? now)} lastKnown={kept} unavailable={reading ? noReading(bucket) : "not read yet"} />)}
    </div>
    {(parts.length > 0 || retryable) && <p className="quick-usage-note">{parts.join(" · ")}
      {retryable && <span className="quick-usage-retry">{parts.length > 0 ? " · " : ""}<button type="button" disabled={loading} onClick={onRetry}>Retry quota</button></span>}</p>}
  </div>;
}
