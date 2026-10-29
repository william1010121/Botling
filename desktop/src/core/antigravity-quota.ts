import type { AntigravityQuotaView } from "../contract";

type Reason = Extract<AntigravityQuotaView, { status: "error" | "unavailable" }>["reason"];
export const quotaUnavailable = (reason: Reason = "no_connection"): AntigravityQuotaView => ({ status: "unavailable", reason, source: "antigravity_acp" });
export const quotaError = (reason: Reason = "request_failed"): AntigravityQuotaView => ({ status: "error", reason, source: "antigravity_acp" });

/** ACP 1.4.3 usage.py formats RetrieveUserQuotaSummary groups/buckets as Markdown.
 * Only parse Quota Limits, never Session Usage. Percentages are provider-rounded
 * to integers and reset timestamps to minutes; counts stay strings for int64.
 * Unknown/missing values are not zero and disabled buckets have no balance.
 */
export function parseAntigravityUsage(text: string, seen = Date.now()): AntigravityQuotaView {
  const section = text.split("### Quota Limits\n");
  if (section.length !== 2) return quotaUnavailable("missing_data");
  const lines = section[1].trimEnd().split("\n");
  if (lines.some(line => line.startsWith("- Unable to retrieve quota status"))) return quotaError();
  if (lines.some(line => /^- (No quota limits reported\.|data not available yet|Not applicable for current authentication method\.)$/.test(line))) return quotaUnavailable("missing_data");
  const buckets: Extract<AntigravityQuotaView, {status: "available"}>["buckets"] = [];
  let group = "";
  for (const line of lines) {
    const heading = /^- \*\*(.+)\*\*$/.exec(line);
    if (heading) { group = heading[1]; continue; }
    if (!line.trim() || /^  \*\(.*\)\*$/.test(line) || line === "  - No active bucket limits") continue;
    const bucket = /^  - \*\*(.+):\*\* (.+)$/.exec(line);
    if (!group || !bucket) return quotaError("invalid_response");
    const entry: typeof buckets[number] = { group, label: bucket[1] };
    let value = bucket[2];
    const reset = / \(resets (.+)\)$/.exec(value);
    if (reset) {
      // Only the pinned formatter's UTC form or an explicit ISO timezone is accepted.
      if (!/^[A-Z][a-z]{2} \d{2}, \d{4}, \d{2}:\d{2} UTC$/.test(reset[1]) && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(reset[1])) return quotaError("invalid_response");
      const time = Date.parse(reset[1]);
      if (!Number.isFinite(time)) return quotaError("invalid_response");
      entry.resetsAt = time; value = value.slice(0, reset.index);
    }
    const fraction = /^(\d+)% remaining$/.exec(value), count = /^(\d{1,3}(?:,\d{3})*|\d+) units remaining$/.exec(value);
    if (fraction) {
      const n = Number(fraction[1]); if (n > 100) return quotaError("invalid_response");
      entry.remainingFraction = n / 100;
    } else if (count) entry.remainingAmount = count[1].replaceAll(",", "");
    else if (/^Disabled(?:: .*)?$/.test(value)) entry.disabled = true;
    else if (value !== "Available") return quotaError("invalid_response");
    buckets.push(entry);
  }
  return buckets.length ? { status: "available", source: "antigravity_acp", seen, buckets } : quotaUnavailable("missing_data");
}

type Reader = () => Promise<AntigravityQuotaView>;
const readers = new Map<string, Set<Reader>>();
/** Scope to the core data directory. Never combine different session/account readings. */
export function registerAntigravityQuotaReader(scope: string, reader: Reader) {
  let set = readers.get(scope); if (!set) readers.set(scope, set = new Set());
  set.add(reader);
  return () => { set.delete(reader); if (!set.size) readers.delete(scope); };
}
export function readAntigravityQuota(): AntigravityQuotaView { return quotaUnavailable(); }
export async function refreshAntigravityQuota(scope: string): Promise<AntigravityQuotaView> {
  const available = readers.get(scope);
  if (!available?.size) return quotaUnavailable();
  // Most recently registered connection belongs to this core. Do not silently switch accounts.
  const reader = [...available].at(-1)!;
  try { return await reader(); } catch { return quotaError(); }
}
