import { describe, expect, it } from "vitest";
import { frameOf, frameParams, ownsCommand, parseFrameRequest } from "../src/frame-protocol";

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

  it("finds the frame a message came from by its window", () => {
    const a = document.createElement("iframe");
    const b = document.createElement("iframe");
    document.body.append(a, b);
    expect(frameOf([a, b], b.contentWindow)).toBe(b);
    expect(frameOf([a, b], window)).toBeNull();
    expect(frameOf([a, b], null)).toBeNull();
  });
});
