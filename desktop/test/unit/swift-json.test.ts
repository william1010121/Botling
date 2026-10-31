import { describe, expect, it } from "vitest";
import { swiftJSON, swiftPrettyJSON } from "../../src/core/swift-json";

describe("swiftJSON", () => {
  it("sorts keys at every level and escapes slashes", () => {
    expect(swiftJSON({ b: 1, a: { d: "x/y", c: [{ z: 1, y: 2 }] } })).toBe('{"a":{"c":[{"y":2,"z":1}],"d":"x\\/y"},"b":1}');
  });
  it("skips undefined members, keeps unicode, handles empty containers", () => {
    expect(swiftJSON({ a: undefined, b: "好👍", c: [], d: {} })).toBe('{"b":"好👍","c":[],"d":{}}');
  });
});

describe("swiftPrettyJSON", () => {
  it("lays out Swift pretty print with 2-space indent and ' : '", () => {
    expect(swiftPrettyJSON({ b: [1, { y: 1, x: null }], a: "好" })).toBe('{\n  "a" : "好",\n  "b" : [\n    1,\n    {\n      "x" : null,\n      "y" : 1\n    }\n  ]\n}');
  });
  it("writes empty containers as an empty line", () => {
    expect(swiftPrettyJSON({ a: [], b: {} })).toBe('{\n  "a" : [\n\n  ],\n  "b" : {\n\n  }\n}');
    expect(swiftPrettyJSON([])).toBe("[\n\n]");
  });
  it("escapes slashes only when asked, in keys too", () => {
    expect(swiftPrettyJSON({ "a/b": "c/d" })).toBe('{\n  "a\\/b" : "c\\/d"\n}');
    expect(swiftPrettyJSON({ "a/b": "c/d" }, { escapeSlashes: false })).toBe('{\n  "a/b" : "c/d"\n}');
  });
  it("skips undefined members", () => {
    expect(swiftPrettyJSON({ a: undefined, b: 1 })).toBe('{\n  "b" : 1\n}');
  });
});
