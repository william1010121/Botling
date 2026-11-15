// What the page's service worker (sw.ts) and the page's shell (shell/sw-bridge.ts) say to each other, and the pure parts
// of the bridge: which requests it answers, the byte-range arithmetic and the refusal rule (M2 step 14, protocol v1 §9A.4
// "phone or browser page loaded from the relay").
//
// - The shell marks the URLs the bridge answers with `sw=1` (`/v3/c/<owner>/<id>/<variant>?e=…&t=…&sw=1`), and only
//   when the page reaches its server through the relay and the worker controls the page. Every other request, the
//   tailnet path's `/v3/c/` URLs included, never reaches the bridge: the worker does not answer it, the browser fetches
//   it as before.
// - Range arithmetic: exactly src/main/preview-response.ts `rangedResponse` (one `bytes=` range: 200 whole, 206 with
//   `Content-Range`, 416 with `bytes */size`), so the bridge answers as the server does (a unit test compares both).
// - Refusals: as src/server/content/remote.ts `mediaLoaderRefusal` (M2 step 11): WebKit's media loader (its requests
//   carry `X-Playback-Session-Id` and `Range`) retries a refused range in a tight loop, so a refusal of such a request
//   is an empty 200 with the status in `X-Botling-Status`; every other request gets the status itself.

/** The query mark of a URL the bridge answers. */
export const SW_MARK = "sw";

/** The shell's URL for the bridge: the server's content URL plus `sw=1`. */
export function markForBridge(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${SW_MARK}=1`;
}

/** The server's content URL a bridge URL stands for (the mark removed), or null when it is not one. */
export function unmarkBridge(pathAndQuery: string): string | null {
  if (!pathAndQuery.startsWith("/v3/c/")) return null;
  const mark = pathAndQuery.indexOf("?");
  if (mark < 0) return null;
  const query = new URLSearchParams(pathAndQuery.slice(mark + 1));
  if (query.get(SW_MARK) !== "1") return null;
  query.delete(SW_MARK);
  return `${pathAndQuery.slice(0, mark)}?${query.toString()}`;
}

/** A `/v3/c/` URL's parts the bridge reads with (the ticket is not needed: the session is the credential). */
export interface BridgeTarget { owner: string; id: string; variant: string; entry: { stream: string; seq: number } }

/** The parts of a bridge URL, or null (the same shape checks as the server's parser, without zod). */
export function bridgeTarget(pathAndQuery: string): BridgeTarget | null {
  const plain = unmarkBridge(pathAndQuery);
  if (!plain) return null;
  const mark = plain.indexOf("?");
  const parts = plain.slice("/v3/c/".length, mark).split("/");
  if (parts.length !== 3) return null;
  let owner: string, id: string, variant: string;
  try { [owner, id, variant] = parts.map((part) => decodeURIComponent(part)) as [string, string, string]; } catch { return null; }
  if (!owner || !/^sha256:[0-9a-f]{64}$/.test(id) || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(variant)) return null;
  const e = new URLSearchParams(plain.slice(mark + 1)).get("e") ?? "";
  const dot = e.lastIndexOf(".");
  if (dot <= 0 || !/^[1-9][0-9]{0,15}$/.test(e.slice(dot + 1))) return null;
  const seq = Number(e.slice(dot + 1));
  if (!Number.isSafeInteger(seq)) return null;
  return { owner, id, variant, entry: { stream: e.slice(0, dot), seq } };
}

/** What a Range header asks for, before the size is known. */
export type RangeAsk =
  | { kind: "whole" }
  | { kind: "from"; start: number; end: number | null }
  | { kind: "suffix"; length: number }
  | { kind: "invalid" };

/** Reads one `bytes=` range (what `rangedResponse` accepts; anything else is invalid → 416 once the size is known). */
export function askedRange(header: string | null): RangeAsk {
  if (!header) return { kind: "whole" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !(match[1] || match[2])) return { kind: "invalid" };
  if (!match[1]) {
    const length = Number(match[2]);
    return Number.isSafeInteger(length) && length > 0 ? { kind: "suffix", length } : { kind: "invalid" };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  if (!Number.isSafeInteger(start) || (end !== null && !Number.isSafeInteger(end))) return { kind: "invalid" };
  return { kind: "from", start, end };
}

/** The answer's status and range for a file of `size` bytes: what `rangedResponse` would send. */
export interface RangePlan { status: 200 | 206 | 416; start: number; end: number; length: number; contentRange?: string }

export function planRange(header: string | null, size: number): RangePlan {
  let start = 0, end = size - 1, status: 200 | 206 = 200;
  if (header) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    let valid = !!match && !!(match[1] || match[2]) && size > 0;
    if (valid && match) {
      if (!match[1]) { const suffix = Number(match[2]); valid = Number.isSafeInteger(suffix) && suffix > 0; start = Math.max(0, size - suffix); }
      else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && end >= start; end = Math.min(end, size - 1); }
    }
    if (!valid) return { status: 416, start: 0, end: -1, length: 0, contentRange: `bytes */${size}` };
    status = 206;
  }
  const length = Math.max(0, end - start + 1);
  return { status, start, end, length, ...(status === 206 ? { contentRange: `bytes ${start}-${end}/${size}` } : {}) };
}

/** The page policy the server gives content answers (src/main-v3/content-protocol.ts CHAT_MEDIA_CSP). */
export const CONTENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'";

/** The headers of a bridge answer of `type` (as the server's `fileHeaders`, plus its CORP), for a planned range. */
export function answerHeaders(type: string, plan: RangePlan, size: number): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": type, "Content-Security-Policy": CONTENT_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Accept-Ranges": "bytes",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
  if (plan.status === 416) { headers["Content-Range"] = `bytes */${size}`; headers["Content-Length"] = "0"; return headers; }
  if (plan.contentRange) headers["Content-Range"] = plan.contentRange;
  headers["Content-Length"] = String(plan.length);
  return headers;
}

/** Why a read could not be served (the server's `content.gone` reasons, plus the bridge's own). */
export type BridgeGone = "changed" | "deleted" | "denied" | "offline" | "too-large" | "no-session";

/** The status of a refusal (as src/main-v3/content-protocol.ts `goneResponse`; no session = offline). */
export function goneStatus(reason: BridgeGone): number {
  return reason === "denied" ? 404 : reason === "offline" || reason === "no-session" ? 503 : 410;
}

/** The refusal rule for WebKit's media loader (`mediaLoaderRefusal`): true when the status goes in a header of an empty 200. */
export function loaderRefusal(status: number, headers: { get(name: string): string | null }): boolean {
  return status >= 400 && !!headers.get("x-playback-session-id") && !!headers.get("range");
}

// --- Messages ------------------------------------------------------------------------------------------------------

/** Worker → every window client of the page, with a MessagePort: read this range for me. */
export interface SwGet {
  botling3: "sw.get";
  target: BridgeTarget;
  offset: number;
  length: number;
}

/** Shell → worker on the port. The first port that answers anything serves the read; the others are cancelled. */
export type ShellToSw =
  | { t: "meta"; size: number; type: string }
  | { t: "chunk"; offset: number; bytes: ArrayBuffer }
  | { t: "gone"; reason: BridgeGone };

/** Worker → shell on the port: more window (bytes the player has read), or the player seeked away or closed. */
export type SwToShell = { t: "credit"; bytes: number } | { t: "cancel" };

/** Worker → page: the worker is up (an answer to `sw.ping`). */
export interface SwPong { botling3: "sw.pong"; version: number }
export const SW_VERSION = 1;
