// Client hints in the in-app browser pane (2026-11-10): Electron sends a Chrome user agent but no Sec-CH-UA*, which
// no real Chrome does, and Cloudflare's "Verify you are human" never passed. The session now adds Chrome's headers
// with the same brands as navigator.userAgentData.
import { describe, expect, it } from "vitest";
import { HintAsks, acceptLanguages, acceptedHints, chromiumBrands, isSecureUrl, withHints, type HintFacts } from "../../src/browser-hints";

const facts: HintFacts = { chrome: "152.0.7977.167", platform: "darwin", arch: "arm64", systemVersion: "26.3.0" };
const plain = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36", Accept: "*/*" };

describe("brands", () => {
  it("are Chromium's for the major version, as navigator.userAgentData reports them in Electron 44 (Chrome 152)", () => {
    // Read from navigator.userAgentData / getHighEntropyValues in Electron 44.9.3 on 2026-11-10.
    expect(chromiumBrands("152.0.7977.167")).toEqual([{ brand: "Not?A_Brand", version: "24" }, { brand: "Chromium", version: "152" }]);
    expect(chromiumBrands("152.0.7977.167", true)).toEqual([{ brand: "Not?A_Brand", version: "24.0.0.0" }, { brand: "Chromium", version: "152.0.7977.167" }]);
  });
  it("follow Chromium's grease for other versions (Chrome 131 sent \"Not_A Brand\";v=\"24\")", () => {
    expect(chromiumBrands("146.0.7680.65")).toEqual([{ brand: "Not-A.Brand", version: "24" }, { brand: "Chromium", version: "146" }]);
    expect(chromiumBrands("131.0.1.2")).toEqual([{ brand: "Chromium", version: "131" }, { brand: "Not_A Brand", version: "24" }]);
  });
});

describe("request headers", () => {
  it("before the fix: a Chrome user agent with no Sec-CH-UA at all is what Electron sent", () => {
    expect(Object.keys(plain).some((name) => name.toLowerCase().startsWith("sec-ch-ua"))).toBe(false);
  });
  it("an https request gets Chrome's three low-entropy hints, matching the user agent's major version", () => {
    const out = withHints("https://claude.ai/", plain, facts);
    expect(out["sec-ch-ua"]).toBe('"Not?A_Brand";v="24", "Chromium";v="152"');
    expect(out["sec-ch-ua-mobile"]).toBe("?0");
    expect(out["sec-ch-ua-platform"]).toBe('"macOS"');
    expect(out["User-Agent"]).toBe(plain["User-Agent"]);
    expect(out["sec-ch-ua-full-version-list"]).toBeUndefined();
  });
  it("puts the hints first, before User-Agent, as Chrome orders them", () => {
    expect(Object.keys(withHints("https://claude.ai/", plain, facts))).toEqual(["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "User-Agent", "Accept"]);
  });
  it("Cloudflare's challenge iframe (a third party) gets them too", () => {
    expect(withHints("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0/rcv/x", plain, facts)["sec-ch-ua"]).toContain("Chromium");
  });
  it("plain http gets none, and a stale or forged one is dropped", () => {
    const out = withHints("http://example.com/", { ...plain, "Sec-CH-UA": '"Electron";v="44"' }, facts);
    expect(Object.keys(out).filter((name) => name.toLowerCase().startsWith("sec-ch-ua"))).toEqual([]);
    expect(withHints("https://a.com/", { "sec-ch-ua": '"Electron";v="44"' }, facts)["sec-ch-ua"]).toBe('"Not?A_Brand";v="24", "Chromium";v="152"');
  });
  it("high-entropy hints go only to an origin that asked with Accept-CH", () => {
    const asks = new HintAsks();
    asks.record("https://claude.ai/", { "Accept-CH": ["Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, DPR"] });
    const out = withHints("https://claude.ai/api/x", plain, facts, asks.for("https://claude.ai/api/x"));
    expect(out["sec-ch-ua-full-version-list"]).toBe('"Not?A_Brand";v="24.0.0.0", "Chromium";v="152.0.7977.167"');
    expect(out["sec-ch-ua-platform-version"]).toBe('"26.3.0"');
    expect(out["sec-ch-ua-arch"]).toBe('"arm"');
    expect(withHints("https://other.com/", plain, facts, asks.for("https://other.com/"))["sec-ch-ua-arch"]).toBeUndefined();
  });
  it("reads Accept-CH lists and knows secure URLs", () => {
    expect(acceptedHints("sec-ch-ua-model , Viewport-Width,Sec-CH-UA-WoW64")).toEqual(["sec-ch-ua-model", "sec-ch-ua-wow64"]);
    expect(isSecureUrl("https://x.com")).toBe(true);
    expect(isSecureUrl("http://localhost:3000/")).toBe(true);
    expect(isSecureUrl("http://x.com")).toBe(false);
  });
});

describe("accept languages", () => {
  it("lists every language the page sees, not only the first", () => {
    expect(acceptLanguages(["en-GB", "zh-Hant-TW"])).toBe("en-GB,zh-Hant-TW");
    expect(acceptLanguages(["en-GB", "bad;q=1"])).toBe("en-GB");
  });
});
