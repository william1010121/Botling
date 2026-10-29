import type { AntigravityQuotaView } from "../contract";

/** Botling's pinned ACP 1.4.3 connection exposes models and turn token counts,
 * but has no supported subscription-quota read operation. /usage is explicitly
 * blocked by AgyAcpProtocol.prompt; do not send it as a model prompt, launch a
 * session, read credentials, or infer remaining quota from those other fields.
 * This capability result needs no network request and writes no provider settings.
 */
export function readAntigravityQuota(): AntigravityQuotaView {
  return { status: "unavailable", reason: "unsupported_connection", source: "antigravity_acp" };
}
