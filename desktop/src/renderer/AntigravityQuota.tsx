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

/** Provider-defined model groups and windows; never inferred from tokens. Shown like Claude's and Codex's cards. */
export function AntigravityQuota({ quota, loading = false, failed = false, onRetry, now = Date.now() }: {
  quota?: AntigravityQuotaView; loading?: boolean; failed?: boolean; onRetry?: () => void; now?: number;
}) {
  const busy = quota?.status === "unavailable" && quota.reason === "busy";
  const reading = quota?.status === "available" ? quota : busy ? quota.lastKnown : undefined;
  if (!failed && reading) {
    const gemini = reading.buckets.filter(isGemini);
    const five = gemini.find(isFiveHour), week = gemini.find(isWeek);
    const cards: [string, Bucket | undefined, boolean][] = [["5 hours", five, false], ["Week", week, true]];
    const stale = now - reading.seen >= STALE_AFTER_MS;
    return <div role="group" aria-label="Antigravity quota" aria-live="polite">
      <div className="quick-usage-cards">
        {cards.map(([title, bucket, weekly]) => <QuotaCard key={title} engine="Antigravity Gemini" title={title} now={now} weekly={weekly}
          window={usedWindow(bucket, reading.seen)} lastKnown={busy} unavailable={noReading(bucket)} />)}
      </div>
      {(busy || stale) && <p className="quick-usage-note">{busy ? "Last known quota · " : ""}{asOf(reading.seen, now)}</p>}
      {busy && <p className="quick-usage-note">Antigravity is working. Waiting to refresh quota.</p>}
    </div>;
  }
  const detail = failed || quota?.status === "error" ? "Quota refresh failed."
    : loading ? "Loading quota…"
    : quota?.status === "unavailable" && quota.reason === "busy" ? "Antigravity is working. Waiting to read quota."
    : quota?.status === "unavailable" && quota.reason === "no_connection" ? "Connect Antigravity to read quota."
    : "Quota readings unavailable.";
  return <div role="group" aria-label="Antigravity quota" aria-live="polite"><p className="quick-usage-note">{detail}</p>{busy && onRetry && <button type="button" disabled={loading} onClick={onRetry}>Retry quota</button>}</div>;
}
