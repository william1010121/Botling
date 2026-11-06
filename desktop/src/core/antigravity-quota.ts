import type { AntigravityQuotaView } from "../contract";
import { readAgyQuotaInProfiles } from "./agy-quota-api";

type Reason = Extract<AntigravityQuotaView, { status: "error" | "unavailable" }>["reason"];
export const quotaUnavailable = (reason: Reason = "no_connection"): AntigravityQuotaView => ({ status: "unavailable", reason, source: "antigravity_acp" });
export const quotaError = (reason: Reason = "request_failed"): AntigravityQuotaView => ({ status: "error", reason, source: "antigravity_acp" });

type Reader = () => Promise<AntigravityQuotaView>;
const readers = new Map<string, Set<Reader>>();
/** Scope to the core data directory. Never combine different session/account readings. */
export function registerAntigravityQuotaReader(scope: string, reader: Reader) {
  let set = readers.get(scope); if (!set) readers.set(scope, set = new Set());
  set.add(reader);
  return () => { set.delete(reader); if (!set.size) readers.delete(scope); };
}
export function readAntigravityQuota(): AntigravityQuotaView { return quotaUnavailable(); }
/** The quota for a core data directory: through its running agy connection's profile, else the profile signed in last. */
export async function refreshAntigravityQuota(scope: string): Promise<AntigravityQuotaView> {
  const available = readers.get(scope);
  if (!available?.size) { try { return await readAgyQuotaInProfiles(scope); } catch { return quotaUnavailable(); } }
  // Most recently registered connection belongs to this core. Do not silently switch accounts.
  const reader = [...available].at(-1)!;
  try { return await reader(); } catch { return quotaError(); }
}
