// A turn that claude ended on a passing API failure: Cloudflare's "Attention Required" page (a 403), a rate limit or
// overload (429, 529) or a server error (5xx) (a connection with no answer at all is network-resume.ts's). claude reports it on stdout as an
// assistant line with `is_api_error_message` and the HTTP status (`api_error_status`), then a result with `is_error`
// true, the same status and its error text as `result` (claude 2.1.323):
//   {"type":"result","subtype":"success","is_error":true,"api_error_status":403,
//    "result":"Failed to authenticate. API Error: 403 Attention Required! | Cloudflare"}
// claude has already retried the request itself by then. The app tries the turn again in the same session a few times,
// further apart each time (heads: bot.ts; workers: claude-workers.ts), and shows a short line instead of claude's words;
// it never retries a real sign-in problem (401: invalid API key, not logged in).

/** How long to wait before each retry (BOTLING_API_RETRY_MS: comma-separated, for tests). Its length is the most tried. */
export function apiRetryDelays(env: NodeJS.ProcessEnv = process.env): number[] {
  const given = (env.BOTLING_API_RETRY_MS ?? "").split(",").filter((part) => part.trim()).map((part) => Number(part.trim())).filter((ms) => Number.isFinite(ms) && ms >= 0);
  return given.length ? given : [30_000, 120_000, 300_000];
}

/** Statuses that pass: a timeout, too early, a rate limit, a server error or overload. */
const PASSING = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
/** A 403 that is a proxy's block page (Cloudflare's), not the API refusing the account. */
const BLOCK_PAGE = /cloudflare|attention required|just a moment|<html|cf-ray/i;
/** A subscription's own limit: retrying minutes later does not help, it resets in hours. */
const USAGE_LIMIT = /usage limit|hit your limit|limit reached|out of extra usage|resets at/i;
/** A real sign-in problem. */
const SIGN_IN = /invalid x-api-key|invalid api key|authentication_error|not logged in|please run \/login|oauth token (?:has )?(?:expired|revoked)/i;
/**
 * No status: an overload or rate limit named in claude's own API error line. A connection that dropped with no answer
 * at all (ECONNRESET, ETIMEDOUT, "Connection error.") is network-resume.ts's: the bot waits until the API answers again.
 */
const PASSING_TEXT = /overloaded|rate.?limit|\b(?:429|5\d\d)\b/i;

/**
 * Whether a failed turn's API error passes and the turn is worth trying again. `status`: claude's `api_error_status`
 * (null/undefined: none); `text`: its error words.
 */
export function passingApiError(status: number | null | undefined, text: string): boolean {
  if (SIGN_IN.test(text) || USAGE_LIMIT.test(text)) return false;
  if (typeof status === "number") {
    if (status === 403) return BLOCK_PAGE.test(text);
    return PASSING.has(status) || (status >= 500 && status < 600);
  }
  return /api error/i.test(text) && PASSING_TEXT.test(text);
}

const seconds = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60_000)} 分鐘`;

/** The short line while it waits: "API 暫時擋住，30 秒後重試（1/3）". */
export function apiRetryText(attempt: number, max: number, delayMs: number): string {
  return `API 暫時擋住，${seconds(delayMs)}後重試（${attempt}/${max}）`;
}

/** The one line once every retry failed too (claude's words are kept short in the parentheses). */
export function apiGaveUpText(max: number, detail: string): string {
  const first = detail.trim().split(/\r?\n/)[0]?.slice(0, 160) ?? "";
  return `Claude 的 API 暫時擋住了這次的請求，重試 ${max} 次後仍然失敗，所以先停下來了。請稍後再傳一次訊息讓它接著做。${first ? `（${first}）` : ""}`;
}

/** What claude is told when the turn is tried again: it goes on in the same session, nothing done is redone. */
export const API_RETRY_NOTE = "(App: the Claude API turned the last request away for a moment (a temporary block or overload). Carry on with what you were doing, from where you left off; do not start over or redo steps that already finished.)";
