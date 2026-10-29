import { useState } from "react";
import type { AntigravityQuotaView } from "../contract";

/** Provider-defined model groups and windows; never inferred from tokens. */
export function AntigravityQuota({ quota, loading = false, failed = false, onRetry }: {
  quota?: AntigravityQuotaView; loading?: boolean; failed?: boolean; onRetry?: () => void;
}) {
  const [lastReading, setLastReading] = useState<Extract<AntigravityQuotaView, { status: "available" }>>();
  if (quota?.status === "available" && quota !== lastReading) setLastReading(quota);
  const busy = quota?.status === "unavailable" && quota.reason === "busy";
  const reading = quota?.status === "available" ? quota : busy ? lastReading : undefined;
  if (!failed && !loading && reading) return <div role="group" aria-label="Antigravity quota" aria-live="polite">
    {reading.buckets.map((bucket, index) => <p className="quick-usage-note" key={index}>
      <strong>{bucket.group} · {bucket.label}</strong>{": "}
      {bucket.disabled ? "Disabled" : bucket.remainingFraction !== undefined ? `${Math.round(bucket.remainingFraction * 100)}% remaining`
        : bucket.remainingAmount !== undefined ? `${bucket.remainingAmount} units remaining` : "Remaining quota not reported"}
      {bucket.resetsAt !== undefined && <> · Resets {new Date(bucket.resetsAt).toLocaleString()}</>}
    </p>)}
    <p className="quick-usage-note">{busy ? "Last known quota · Read " : "Read "}{new Date(reading.seen).toLocaleString()}</p>
    {busy && <p className="quick-usage-note">Antigravity is working. Waiting to refresh quota.</p>}
  </div>;
  const detail = failed || quota?.status === "error" ? "Quota refresh failed."
    : loading ? "Loading quota…"
    : quota?.status === "unavailable" && quota.reason === "busy" ? "Antigravity is working. Waiting to read quota."
    : quota?.status === "unavailable" && quota.reason === "no_connection" ? "Connect Antigravity to read quota."
    : "Quota readings unavailable.";
  return <div role="group" aria-label="Antigravity quota" aria-live="polite"><p className="quick-usage-note">{detail}</p>{busy && onRetry && <button type="button" onClick={onRetry}>Retry quota</button>}</div>;
}
