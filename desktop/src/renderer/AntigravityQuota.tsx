import type { AntigravityQuotaView } from "../contract";

/** Provider-defined model groups and windows; never inferred from tokens. */
export function AntigravityQuota({ quota, loading = false, failed = false }: {
  quota?: AntigravityQuotaView; loading?: boolean; failed?: boolean;
}) {
  if (!failed && !loading && quota?.status === "available") return <div role="group" aria-label="Antigravity quota" aria-live="polite">
    {quota.buckets.map((bucket, index) => <p className="quick-usage-note" key={index}>
      <strong>{bucket.group} · {bucket.label}</strong>{": "}
      {bucket.disabled ? "Disabled" : bucket.remainingFraction !== undefined ? `${Math.round(bucket.remainingFraction * 100)}% remaining`
        : bucket.remainingAmount !== undefined ? `${bucket.remainingAmount} units remaining` : "Remaining quota not reported"}
      {bucket.resetsAt !== undefined && <> · Resets {new Date(bucket.resetsAt).toLocaleString()}</>}
    </p>)}
    <p className="quick-usage-note">Read {new Date(quota.seen).toLocaleString()}</p>
  </div>;
  const detail = failed || quota?.status === "error" ? "Quota refresh failed."
    : loading ? "Loading quota…"
    : quota?.status === "unavailable" && quota.reason === "busy" ? "Antigravity is busy. Refresh quota after the turn."
    : quota?.status === "unavailable" && quota.reason === "no_connection" ? "Connect Antigravity to read quota."
    : "Quota readings unavailable.";
  return <div role="group" aria-label="Antigravity quota" aria-live="polite"><p className="quick-usage-note">{detail}</p></div>;
}
