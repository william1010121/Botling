// M2 step 14: the pure parts of the page's content bridge (web-v3/sw-wire.ts). The range plan must answer exactly as the
// server does (src/main/preview-response.ts `rangedResponse`, which `/v3/c/` answers go through), the bridge URL must
// round-trip the server's content URL, and refusals follow the server's statuses and WebKit's loader rule.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rangedResponse } from "../../src/main/preview-response";
import { CHAT_MEDIA_CSP, goneResponse } from "../../src/main-v3/content-protocol";
import { mediaLoaderRefusal } from "../../src/server/content/remote";
import { contentUrlPath, parseContentUrl } from "../../src/protocol";
import { answerHeaders, askedRange, bridgeTarget, CONTENT_CSP, goneStatus, loaderRefusal, markForBridge, planRange, unmarkBridge } from "../../web-v3/sw-wire";

const SIZES = [0, 1, 2, 10, 1023, 65_536, 1_048_577, 5_219_142];
const RANGES = (size: number) => [
  null, "bytes=0-", "bytes=0-0", "bytes=0-1", "bytes=1-", "bytes=5-9", "bytes=-1", "bytes=-10", "bytes=-0", "bytes=-",
  `bytes=${size}-`, `bytes=${size - 1}-`, `bytes=0-${size}`, `bytes=0-${size * 2}`, `bytes=${Math.floor(size / 2)}-`, `bytes=-${size + 5}`,
  "bytes=9-5", "bytes=abc", "items=0-1", "bytes=0-1,4-5", "bytes= 0-1", `bytes=${Number.MAX_SAFE_INTEGER}0-`,
];

describe("M2 step 14: the content bridge's range plan", () => {
  it("answers status, Content-Range and Content-Length exactly as rangedResponse, for every size × Range × GET/HEAD", async () => {
    let checked = 0;
    for (const size of SIZES) {
      for (const range of RANGES(size)) {
        for (const method of ["GET", "HEAD"]) {
          const request = new Request("http://127.0.0.1/x", { method, headers: range ? { range } : {} });
          let body: [number, number] | null = null;
          const server = rangedResponse(request, size, new Headers({ "Content-Type": "video/mp4" }), (start, end) => { body = [start, end]; return new ReadableStream({ start(c) { c.close(); } }); });
          const plan = planRange(range, size);
          const headers = answerHeaders("video/mp4", plan, size);
          expect(plan.status, `${size} ${range} ${method}`).toBe(server.status);
          expect(headers["Content-Range"] ?? null, `${size} ${range}`).toBe(server.headers.get("content-range"));
          expect(headers["Content-Length"], `${size} ${range}`).toBe(server.headers.get("content-length"));
          if (body) expect([plan.start, plan.end], `${size} ${range}`).toEqual(body);
          await server.body?.cancel();
          checked++;
        }
      }
    }
    expect(checked).toBe(SIZES.length * RANGES(0).length * 2);
  });

  it("reads the asked range before the size is known", () => {
    expect(askedRange(null)).toEqual({ kind: "whole" });
    expect(askedRange("bytes=5-")).toEqual({ kind: "from", start: 5, end: null });
    expect(askedRange("bytes=5-9")).toEqual({ kind: "from", start: 5, end: 9 });
    expect(askedRange("bytes=-100")).toEqual({ kind: "suffix", length: 100 });
    for (const bad of ["bytes=-0", "bytes=-", "bytes=a-", "items=0-1", "bytes=0-1,2-3"]) expect(askedRange(bad).kind, bad).toBe("invalid");
  });

  it("sends the server's content headers (type, page policy, no store, ranges, CORP)", () => {
    expect(CONTENT_CSP).toBe(CHAT_MEDIA_CSP);
    const headers = answerHeaders("application/pdf", planRange("bytes=0-65535", 5_000_000), 5_000_000);
    expect(headers).toMatchObject({ "Content-Type": "application/pdf", "Cache-Control": "no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "cross-origin", "Content-Range": "bytes 0-65535/5000000", "Content-Length": "65536" });
  });
});

describe("M2 step 14: bridge URLs and refusals", () => {
  const owner = "S".repeat(26);
  const id = `sha256:${"ab".repeat(32)}`;
  const entry = { stream: `bot:${"b".repeat(26)}`, seq: 42 } as never;
  const ticket = "t".repeat(43);

  it("marks the server's URL with sw=1 and gets the same parts back; unmarked URLs are not the bridge's", () => {
    const plain = contentUrlPath({ owner, id, variant: "preview", entry, ticket });
    const marked = markForBridge(plain);
    expect(marked).toBe(`${plain}&sw=1`);
    expect(unmarkBridge(marked)).toBe(plain);
    const parsed = parseContentUrl(plain)!;
    expect(bridgeTarget(marked)).toEqual({ owner, id, variant: "preview", entry: { stream: parsed.entry.stream, seq: 42 } });
    // The tailnet path's URLs (no mark), another path, and malformed ones never go to the bridge.
    expect(bridgeTarget(plain)).toBeNull();
    expect(bridgeTarget(`/v3/pdf.html?sw=1`)).toBeNull();
    expect(bridgeTarget(`/v3/c/${owner}/${id}/original?sw=1`)).toBeNull();
    expect(bridgeTarget(`/v3/c/${owner}/sha256:zz/original?e=x.1&sw=1`)).toBeNull();
    expect(bridgeTarget(`/v3/c/${owner}/${id}/original?e=x.0&sw=1`)).toBeNull();
    expect(bridgeTarget(`/mobile/c/${owner}/${id}/original?e=x.1&sw=1`)).toBeNull();
  });

  it("refuses with the server's statuses, and as WebKit's loader needs (empty 200 + X-Botling-Status)", () => {
    for (const reason of ["changed", "deleted", "denied", "offline", "too-large"] as const) expect(goneStatus(reason), reason).toBe(goneResponse(reason).status);
    expect(goneStatus("no-session")).toBe(503);
    for (const [status, headers] of [
      [410, { "x-playback-session-id": "A", range: "bytes=0-1" }], [410, { range: "bytes=0-1" }], [410, { "x-playback-session-id": "A" }],
      [403, { "x-playback-session-id": "A", range: "bytes=5-" }], [206, { "x-playback-session-id": "A", range: "bytes=0-1" }], [416, { "x-playback-session-id": "A", range: "bytes=9-" }],
    ] as const) {
      const server = mediaLoaderRefusal(new Response("x", { status }), headers as Record<string, string>);
      const empty200 = server.status === 200 && server.headers.get("x-botling-status") === String(status);
      expect(loaderRefusal(status, new Headers(headers as Record<string, string>)), `${status} ${JSON.stringify(headers)}`).toBe(empty200);
    }
  });

  it("the worker stores nothing (no Cache Storage, no IndexedDB, no localStorage) and answers only bridge URLs", () => {
    const source = readFileSync(join(__dirname, "../../web-v3/sw.ts"), "utf8").replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/\bcaches\b|indexedDB|localStorage|sessionStorage/);
    expect(source).toMatch(/bridgeTarget\(url\.pathname \+ url\.search\)/);
  });
});
