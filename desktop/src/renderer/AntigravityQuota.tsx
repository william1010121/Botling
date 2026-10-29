import type { AntigravityQuotaView } from "../contract";

/** A separate quota state: Antigravity does not promise Claude's 5h/week windows. */
export function AntigravityQuota({ quota, loading = false, failed = false }: {
  quota?: AntigravityQuotaView; loading?: boolean; failed?: boolean;
}) {
  const detail = failed ? "Quota refresh failed."
    : loading ? "Loading quota…"
    : quota?.reason === "unsupported_connection"
      ? "Quota unavailable through the current Antigravity connection."
      : "Quota readings unavailable.";
  return <div role="group" aria-label="Antigravity quota" aria-live="polite">
    <p className="quick-usage-note">{detail}</p>
  </div>;
}
