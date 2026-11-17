// @vitest-environment jsdom
// Component tokens (Web/src/component-tokens.ts): CSS variables a plugin pushes into every component frame.
// What is checked: the names and values the core and the pages both refuse, the tokens reaching the page's html on every
// surface, a page with none being byte for byte what it was, a change reaching frames on screen (told, or built again),
// and the page's own listener taking a change from its parent only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { componentPage, componentElement } from "../../../Web/src/components";
import {
  TOKEN_COUNT_MAX, cleanTokens, componentTokens, componentTokensCss, onComponentTokens, setComponentTokens, tokenListenerScript, tokenName, tokenValue, tokensCss,
} from "../../../Web/src/component-tokens";
import type { ComponentInfo } from "../../../Web/src/types";

afterEach(() => { setComponentTokens({}); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

const compact = { "--ccb-density-space": "2px", "--ccb-density-radius": "4px", "--ccb-density-line": "1.25" };
const info: ComponentInfo = { template: `<div class="card">hi</div>`, version: 1, working: false, updated: false, hasPrevious: false, sizes: ["2x2"], icon: null, title: null };

describe("which names and values are tokens", () => {
  it("takes --ccb- names of lower-case words and short plain CSS values", () => {
    for (const name of ["--ccb-density-space", "--ccb-a", "--ccb-x1-y2"]) expect(tokenName(name), name).toBe(true);
    for (const value of ["4px", "1.4", "0.5rem", "calc(4px * 2)", "-1px", "4px 8px", "#fff", "var(--ccb-x)"]) expect(tokenValue(value), value).toBe(true);
  });

  it("refuses a name that does not start --ccb-, is empty after it, has capitals, spaces or CSS punctuation, or is too long", () => {
    for (const name of ["--density", "--ccb-", "--ccb--x", "--CCB-x", "--ccb-X", "ccb-x", "--ccb-x y", "--ccb-x;color", "--ccb-x:y", "--ccb-x}", "--ccb-" + "a".repeat(60), "color", "", "__proto__", "constructor"]) {
      expect(tokenName(name), name).toBe(false);
    }
    expect(tokenName(5)).toBe(false);
    expect(tokenName(null)).toBe(false);
  });

  it("refuses a value that could end the declaration or the rule, open a tag, a string, a comment, an at-rule or a load", () => {
    for (const value of ["4px;color:red", "4px}body{display:none", "{", "</style><script>alert(1)</script>", "a<b", "a>b", "\"x\"", "'x'", "4px\\", "/* x */", "url(https://x.test/a.png)", "URL (x)", "expression(1)", "image-set(x)", "@import x", "4px !important", "4px\n5px", "4px\u0000", "", "   ", "9".repeat(101)]) {
      expect(tokenValue(value), JSON.stringify(value)).toBe(false);
    }
    for (const value of [4, true, null, undefined, {}, ["4px"]]) expect(tokenValue(value)).toBe(false);
  });

  it("cleanTokens keeps the valid entries, sorted and trimmed, drops the rest, and holds the cap", () => {
    expect(cleanTokens({ "--ccb-b": " 2px ", "--bad": "1px", "--ccb-a": "1px", "--ccb-c": "1px;x", "--ccb-d": 3 })).toEqual({ "--ccb-a": "1px", "--ccb-b": "2px" });
    expect(Object.keys(cleanTokens({ "--ccb-b": "1", "--ccb-a": "1" }))).toEqual(["--ccb-a", "--ccb-b"]);
    for (const input of [null, undefined, "x", 4, ["--ccb-a"], []]) expect(cleanTokens(input)).toEqual({});
    const many = Object.fromEntries(Array.from({ length: TOKEN_COUNT_MAX + 10 }, (_, index) => [`--ccb-n${String(index).padStart(3, "0")}`, "1px"]));
    expect(Object.keys(cleanTokens(many))).toHaveLength(TOKEN_COUNT_MAX);
    // A key that is a prototype name never becomes a token, and nothing leaks onto Object.prototype.
    expect(cleanTokens(JSON.parse('{"__proto__":{"--ccb-x":"1px"},"constructor":"1px"}'))).toEqual({});
    expect(({} as Record<string, unknown>)["--ccb-x"]).toBeUndefined();
  });

  it("tokensCss writes one :root rule, nothing for none, and cleans what it is given", () => {
    expect(tokensCss({})).toBe("");
    expect(tokensCss(compact)).toBe(":root{--ccb-density-line:1.25;--ccb-density-radius:4px;--ccb-density-space:2px}");
    expect(tokensCss({ "--ccb-a": "1px;}body{x:y", "--ccb-b": "2px" })).toBe(":root{--ccb-b:2px}");
  });
});

describe("the page a component gets", () => {
  const surfaces = [["chat", false], ["board", true], ["pinned", false]] as const;

  it("with no tokens set is the page it was, byte for byte (no style, no listener)", () => {
    const html = componentPage(`<div class="card">Hello</div><script>document.querySelector('.card').textContent = ccb.data.text</script>`, `{"text":"hi"}`);
    expect(html).toBe(readFileSync(join(__dirname, "../../../Web/test/fixtures/component-page-legacy/plain-chat-card.html"), "utf8"));
    expect(html).not.toContain("ccb-tokens");
    expect(html).not.toContain("ccbTokens");
  });

  for (const [surface, fill] of surfaces) {
    it(`carries the tokens in its head, before the template, on the ${surface} surface`, () => {
      setComponentTokens(compact);
      const html = componentPage(`<p id="t">x</p>`, "null", {}, "2x2", surface, fill);
      const style = `<style id="ccb-tokens">${tokensCss(compact)}</style>`;
      expect(html).toContain(style);
      expect(html.indexOf(style)).toBeLessThan(html.indexOf("</head>"));
      expect(html.indexOf(style)).toBeLessThan(html.indexOf('<p id="t">'));
      expect(html).toContain("ccbTokens");
    });
  }

  it("never carries a name or value that was refused, even one given straight to setComponentTokens", () => {
    setComponentTokens({ "--ccb-density-space": "2px", "--evil": "1px", "--ccb-x": "1px;}</style><script>alert(1)</script>", "--ccb-y": "url(https://x.test/a)" });
    expect(componentTokens()).toEqual({ "--ccb-density-space": "2px" });
    const html = componentPage(`<p>x</p>`, "null");
    expect(html).toContain(":root{--ccb-density-space:2px}");
    expect(html).not.toContain("--evil");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("x.test");
  });

  it("is the old page again once the tokens are cleared", () => {
    const before = componentPage(`<p>x</p>`, "null");
    setComponentTokens(compact);
    expect(componentPage(`<p>x</p>`, "null")).not.toBe(before);
    setComponentTokens({});
    expect(componentPage(`<p>x</p>`, "null")).toBe(before);
  });
});

describe("setComponentTokens", () => {
  it("tells listeners once per real change, with the set before, and not for the same set or one that cleans to the same", () => {
    const seen: [unknown, unknown][] = [];
    const stop = onComponentTokens((tokens, before) => seen.push([tokens, before]));
    expect(setComponentTokens(compact)).toBe(true);
    expect(setComponentTokens({ ...compact })).toBe(false);
    expect(setComponentTokens({ ...compact, "--bad": "1px" })).toBe(false);
    expect(setComponentTokens({ ...compact, "--ccb-density-space": "6px" })).toBe(true);
    stop();
    expect(setComponentTokens({})).toBe(true);
    expect(seen).toEqual([[compact, {}], [{ ...compact, "--ccb-density-space": "6px" }, compact]]);
    expect(componentTokensCss()).toBe("");
  });
});

describe("a change reaches the frames on screen", () => {
  const draw = (lazy = false) => {
    const wrap = componentElement("note", info, "null", null, undefined, null, null, "2x2", "chat", false, null, lazy)!;
    document.body.append(wrap);
    return wrap.querySelector<HTMLIFrameElement>("iframe")!;
  };

  it("tells a frame built with tokens the new stylesheet, and an empty one when they are cleared, without rebuilding it", () => {
    setComponentTokens(compact);
    const frame = draw();
    const built = frame.getAttribute("srcdoc");
    expect(built).toContain(tokensCss(compact));
    const post = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: post }, configurable: true });
    setComponentTokens({ ...compact, "--ccb-density-space": "6px" });
    expect(post).toHaveBeenLastCalledWith({ ccbTokens: tokensCss({ ...compact, "--ccb-density-space": "6px" }) }, "*");
    setComponentTokens({});
    expect(post).toHaveBeenLastCalledWith({ ccbTokens: "" }, "*");
    expect(post).toHaveBeenCalledTimes(2);
    expect(frame.getAttribute("srcdoc")).toBe(built);
  });

  it("builds a frame again, with the tokens, when it was built before any plugin set them; later changes are told, not rebuilt", () => {
    const frame = draw();
    expect(frame.getAttribute("srcdoc")).not.toContain("ccb-tokens");
    setComponentTokens(compact);
    const rebuilt = frame.getAttribute("srcdoc")!;
    expect(rebuilt).toContain(`<style id="ccb-tokens">${tokensCss(compact)}</style>`);
    const post = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: post }, configurable: true });
    setComponentTokens({ "--ccb-density-space": "9px" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(frame.getAttribute("srcdoc")).toBe(rebuilt);
  });

  it("a frame not built yet (history near the visible chat) is built with the tokens of the time it comes near", () => {
    // An observer that never reports: the frame waits for its turn.
    vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
    const frame = draw(true) as HTMLIFrameElement & { ccbPending?: string | null };
    expect(frame.ccbPending).toEqual(expect.stringContaining("<!doctype html>"));
    expect(frame.ccbPending).not.toContain("ccb-tokens");
    setComponentTokens(compact);
    expect(frame.ccbPending).toContain(tokensCss(compact));
    setComponentTokens({});
    expect(frame.ccbPending).not.toContain("ccb-tokens");
  });

  it("a frame rebuilt keeps showing the data it shows now (a live update), not the one it was first drawn with", () => {
    const frame = draw() as HTMLIFrameElement & { ccbData?: string };
    frame.ccbData = `{"live":"newer"}`;
    setComponentTokens(compact);
    expect(frame.getAttribute("srcdoc")).toContain("newer");
  });

  it("leaves frames that are not on the page alone", () => {
    const wrap = componentElement("note", info, "null", null)!;
    const frame = wrap.querySelector("iframe")!;
    const before = frame.getAttribute("srcdoc");
    setComponentTokens(compact);
    expect(frame.getAttribute("srcdoc")).toBe(before);
  });
});

describe("the page's own listener", () => {
  // Runs the listener as the page does; in jsdom's top window `parent` is the window itself.
  const install = () => {
    document.head.innerHTML = "";
    new Function(tokenListenerScript)();
  };
  const send = (data: unknown, source: unknown = window) => window.dispatchEvent(new MessageEvent("message", { data, source: source as Window }));
  const style = () => document.getElementById("ccb-tokens");

  it("puts a stylesheet from its parent into <style id=ccb-tokens> (made if missing), replaces it, and empties it", () => {
    install();
    send({ ccbTokens: ":root{--ccb-a:1px}" });
    expect(style()!.textContent).toBe(":root{--ccb-a:1px}");
    send({ ccbTokens: ":root{--ccb-a:2px}" });
    expect(document.querySelectorAll("#ccb-tokens")).toHaveLength(1);
    expect(style()!.textContent).toBe(":root{--ccb-a:2px}");
    send({ ccbTokens: "" });
    expect(style()!.textContent).toBe("");
  });

  it("ignores a message from anyone but its parent, and one that is not a string", () => {
    install();
    send({ ccbTokens: ":root{--ccb-a:1px}" }, {});
    send({ ccbTokens: 5 });
    send({ ccbTokens: null });
    send(null);
    send("x");
    expect(style()).toBeNull();
  });
});
