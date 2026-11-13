// A turn claude ends on an API error that passes (core/api-retry.ts): which errors count, and how claude's stream says it
// (claude 2.1.323: an assistant line with is_api_error_message and api_error_status, then a result with is_error).
import { describe, expect, it } from "vitest";
import { apiGaveUpText, apiRetryDelays, apiRetryText, passingApiError } from "../../src/core/api-retry";
import { parseLine } from "../../src/core/agent/stream";

const CLOUDFLARE = "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare";

describe("an API error that passes", () => {
  it("is Cloudflare's block page, a rate limit, an overload or a server error; never a sign-in problem or a usage limit", () => {
    expect(passingApiError(403, CLOUDFLARE)).toBe(true);
    expect(passingApiError(429, "API Error: 429 rate_limit_error")).toBe(true);
    expect(passingApiError(529, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}')).toBe(true);
    expect(passingApiError(500, "API Error: 500 Internal server error")).toBe(true);
    expect(passingApiError(503, "API Error: 503")).toBe(true);
    expect(passingApiError(null, "API Error: Overloaded")).toBe(true);
    expect(passingApiError(401, 'Failed to authenticate. API Error: 401 {"error":{"type":"authentication_error","message":"invalid x-api-key"}}')).toBe(false);
    expect(passingApiError(403, "API Error: 403 permission_error: your organization has been disabled")).toBe(false);
    expect(passingApiError(400, "API Error: 400 prompt is too long")).toBe(false);
    expect(passingApiError(429, "Claude AI usage limit reached|1700000000")).toBe(false);
    expect(passingApiError(null, "Not logged in · Please run /login")).toBe(false);
    // No answer at all is the network's (network-resume.ts), not this.
    expect(passingApiError(null, "API Error: Connection error.")).toBe(false);
  });

  it("waits 30 s, 2 min, 5 min, and says so in one short line; giving up is one plain line", () => {
    expect(apiRetryDelays({})).toEqual([30_000, 120_000, 300_000]);
    expect(apiRetryDelays({ BOTLING_API_RETRY_MS: "5, 10" })).toEqual([5, 10]);
    expect(apiRetryText(1, 3, 30_000)).toBe("API 暫時擋住，30 秒後重試（1/3）");
    expect(apiRetryText(2, 3, 120_000)).toBe("API 暫時擋住，2 分鐘後重試（2/3）");
    expect(apiGaveUpText(3, CLOUDFLARE)).toBe(`Claude 的 API 暫時擋住了這次的請求，重試 3 次後仍然失敗，所以先停下來了。請稍後再傳一次訊息讓它接著做。（${CLOUDFLARE}）`);
  });

  it("is read off claude's stream: the result says it passes, and claude's error words are no reply", () => {
    const assistant = parseLine(JSON.stringify({ type: "assistant", parent_tool_use_id: null, is_api_error_message: true, api_error_status: 403, error: "authentication_failed", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: CLOUDFLARE }] } }));
    expect(assistant).toEqual([]);
    const [result] = parseLine(JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 403, result: CLOUDFLARE, session_id: "s" }));
    expect(result).toMatchObject({ kind: "result", ok: false, error: CLOUDFLARE, apiPassing: true });
    // A real sign-in problem stays as it was: its words show, and it is not tried again.
    const text = 'Failed to authenticate. API Error: 401 {"error":{"type":"authentication_error"}}';
    expect(parseLine(JSON.stringify({ type: "assistant", parent_tool_use_id: null, is_api_error_message: true, api_error_status: 401, message: { role: "assistant", content: [{ type: "text", text }] } })))
      .toEqual([{ kind: "assistantText", text }]);
    const [denied] = parseLine(JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 401, result: text }));
    expect(denied).not.toHaveProperty("apiPassing");
  });
});
