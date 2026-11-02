import { describe, expect, it } from "vitest";
import { builtinCommand, frameOf, frameParams, ownsCommand, parseFrameRequest } from "../src/frame-protocol";

describe("the frame protocol", () => {
  it("reads the four requests a plugin frame may send", () => {
    expect(parseFrameRequest({ ccb: "call", id: 3, method: "count", params: { n: 2 } })).toEqual({ ccb: "call", id: 3, method: "count", params: { n: 2 } });
    expect(parseFrameRequest({ ccb: "call", id: 4, method: "count" })).toEqual({ ccb: "call", id: 4, method: "count", params: null });
    expect(parseFrameRequest({ ccb: "command", id: "charts.refresh" })).toEqual({ ccb: "command", id: "charts.refresh" });
    expect(parseFrameRequest({ ccb: "notify", text: "Saved" })).toEqual({ ccb: "notify", text: "Saved" });
    expect(parseFrameRequest({ ccb: "error", message: "boom" })).toEqual({ ccb: "error", message: "boom" });
  });

  it("refuses a message that names who sent it, or anything else it does not know", () => {
    // Who a frame is comes from the frame (event.source), never from the message.
    expect(parseFrameRequest({ ccb: "call", id: 1, method: "count", params: null, plugin: "other" })).toBeNull();
    expect(parseFrameRequest({ ccb: "command", id: "other.run", plugin: "other" })).toBeNull();
    expect(parseFrameRequest({ ccb: "call", id: "1", method: "count" })).toBeNull();
    expect(parseFrameRequest({ ccb: "call", id: 1, method: "" })).toBeNull();
    expect(parseFrameRequest({ ccb: "call", id: 1, method: "x".repeat(201) })).toBeNull();
    expect(parseFrameRequest({ ccb: "command", id: "bad id!" })).toBeNull();
    expect(parseFrameRequest({ ccb: "ready" })).toBeNull();
    expect(parseFrameRequest("call")).toBeNull();
    expect(parseFrameRequest(null)).toBeNull();
  });

  it("reads a tile ask and an approval ask (plugin-extraction.md W4); neither can say it is allowed", () => {
    expect(parseFrameRequest({ ccb: "tile", id: 1, component: "status", data: { ok: true }, size: "2x1", botId: "main" })).toEqual({ ccb: "tile", id: 1, component: "status", data: { ok: true }, size: "2x1", botId: "main" });
    expect(parseFrameRequest({ ccb: "tile", id: 2, component: "status", size: "1x1", botId: "main" })).toEqual({ ccb: "tile", id: 2, component: "status", data: null, size: "1x1", botId: "main" });
    expect(parseFrameRequest({ ccb: "approval", id: 3, botId: "B1", command: "git log", folder: "/p", card: "gitlog" })).toEqual({ ccb: "approval", id: 3, botId: "B1", command: "git log", folder: "/p", card: "gitlog" });
    expect(parseFrameRequest({ ccb: "approval", id: 4, botId: "B1", command: "git log", folder: "/p" })).toEqual({ ccb: "approval", id: 4, botId: "B1", command: "git log", folder: "/p" });
    // The report shows a picture 2x2; nothing bigger.
    expect(parseFrameRequest({ ccb: "tile", id: 5, component: "status", data: null, size: "2x2", botId: "main" })).toMatchObject({ size: "2x2" });
    expect(parseFrameRequest({ ccb: "tile", id: 55, component: "status", data: null, size: "4x4", botId: "main" })).toBeNull();
    expect(parseFrameRequest({ ccb: "tile", id: 6, component: "", data: null, size: "1x1", botId: "main" })).toBeNull();
    expect(parseFrameRequest({ ccb: "approval", id: 7, botId: "B1", command: "git log", folder: "/p", approved: true })).toBeNull();
    expect(parseFrameRequest({ ccb: "approval", id: 8, botId: "B1", command: "", folder: "/p" })).toBeNull();
    expect(parseFrameRequest({ ccb: "approval", id: 9, botId: "B1", command: "git log", folder: "/p", card: 3 })).toBeNull();
  });

  it("reads a resize (how tall the content is), rounded up and capped; a bad height is not a request", () => {
    expect(parseFrameRequest({ ccb: "resize", height: 120.2 })).toEqual({ ccb: "resize", height: 121 });
    expect(parseFrameRequest({ ccb: "resize", height: 1e9 })).toEqual({ ccb: "resize", height: 20_000 });
    for (const height of [-1, NaN, Infinity, "12", null]) expect(parseFrameRequest({ ccb: "resize", height })).toBeNull();
    expect(parseFrameRequest({ ccb: "resize", height: 5, plugin: "other" })).toBeNull();
  });

  it("parameters must be JSON and not too big", () => {
    expect(frameParams({ a: [1, "b", null] })).toEqual({ ok: true, value: { a: [1, "b", null] } });
    expect(frameParams(undefined)).toEqual({ ok: true, value: null });
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(frameParams(loop)).toEqual({ ok: false, reason: "Its parameters are not JSON." });
    expect(frameParams("x".repeat(1_000_001))).toEqual({ ok: false, reason: "Its parameters are too big." });
  });

  it("a frame runs only its own plugin's commands", () => {
    expect(ownsCommand("charts", "charts.refresh")).toBe(true);
    expect(ownsCommand("charts", "chartsx.refresh")).toBe(false);
    expect(ownsCommand("charts", "other.run")).toBe(false);
    expect(ownsCommand("charts", "charts")).toBe(false);
  });

  it("a command may carry a few string arguments (plan W2)", () => {
    expect(parseFrameRequest({ ccb: "command", id: "charts.open", args: ["B1", "x"] })).toEqual({ ccb: "command", id: "charts.open", args: ["B1", "x"] });
    expect(parseFrameRequest({ ccb: "command", id: "charts.open", args: [] })).toEqual({ ccb: "command", id: "charts.open" });
    expect(parseFrameRequest({ ccb: "command", id: "charts.open", args: [1] })).toBeNull();
    expect(parseFrameRequest({ ccb: "command", id: "charts.open", args: ["a", "b", "c", "d", "e"] })).toBeNull();
    expect(parseFrameRequest({ ccb: "command", id: "charts.open", args: ["x".repeat(4_001)] })).toBeNull();
  });

  it("Botling's own commands a frame may run: openChat(botId) and openResult(botId, url), nothing else", () => {
    expect(builtinCommand("botling.openChat", ["B1"])).toEqual({ id: "botling.openChat", botId: "B1" });
    expect(builtinCommand("botling.openResult", ["B1", "https://example.com/a"])).toEqual({ id: "botling.openResult", botId: "B1", url: "https://example.com/a" });
    expect(builtinCommand("botling.openLink", ["B1", "https://github.com/o/r/pull/1"])).toEqual({ id: "botling.openLink", botId: "B1", url: "https://github.com/o/r/pull/1" });
    expect(builtinCommand("botling.openLink", ["B1"])).toBeNull();
    expect(builtinCommand("botling.openTab", ["B1", "botling.git", "botling.git.review"])).toEqual({ id: "botling.openTab", botId: "B1", plugin: "botling.git", view: "botling.git.review" });
    expect(builtinCommand("botling.openTab", ["B1", "botling.git"])).toBeNull();
    expect(builtinCommand("botling.openTab", ["B1", "", "v"])).toBeNull();
    expect(builtinCommand("botling.openChat", [])).toBeNull();
    expect(builtinCommand("botling.openChat", ["B1", "extra"])).toBeNull();
    expect(builtinCommand("botling.openResult", ["B1"])).toBeNull();
    expect(builtinCommand("botling.openChat", [""])).toBeNull();
    expect(builtinCommand("botling.settings", [])).toBeNull();
    expect(builtinCommand("charts.open", ["B1"])).toBeNull();
  });

  it("finds the frame a message came from by its window", () => {
    const a = document.createElement("iframe");
    const b = document.createElement("iframe");
    document.body.append(a, b);
    expect(frameOf([a, b], b.contentWindow)).toBe(b);
    expect(frameOf([a, b], window)).toBeNull();
    expect(frameOf([a, b], null)).toBeNull();
  });
});
