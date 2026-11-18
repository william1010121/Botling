// The Antigravity file helper is pinned by its bytes (AGY_FILE_HELPER_SHA). clang's output depends on the Xcode, so the pinned bytes are kept as text
// (scripts/agy-file-helper.pinned.base64) and a build whose own compile differs packages them instead (scripts/package-agy-helper.mjs `pickHelper`).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGY_FILE_HELPER_SHA } from "../../src/core/agent/agy-mcp";
import { pickHelper } from "../../scripts/package-agy-helper.mjs";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const kept = Buffer.from(readFileSync(join(__dirname, "../../scripts/agy-file-helper.pinned.base64"), "utf8").trim(), "base64");

describe("the kept pinned helper", () => {
  it("is the pin: a changed pin or a changed file fails here, not at a release", () => {
    expect(sha(kept)).toBe(AGY_FILE_HELPER_SHA);
  });
});

describe("pickHelper", () => {
  const pin = sha(Buffer.from("pinned bytes"));
  const pinned = Buffer.from("pinned bytes");
  const other = Buffer.from("another xcode's bytes");
  it("takes its own compile when that is the pin", () => {
    expect(pickHelper(pinned, other, pin)).toEqual({ bytes: pinned, how: "compiled" });
    expect(pickHelper(pinned, null, pin)).toEqual({ bytes: pinned, how: "compiled" });
  });
  it("takes the kept bytes when its own compile differs and the kept bytes are the pin", () => {
    expect(pickHelper(other, pinned, pin)).toEqual({ bytes: pinned, how: "pinned" });
  });
  it("takes nothing when neither is the pin (the build stops), never the compile's bytes", () => {
    expect(pickHelper(other, Buffer.from("stale kept bytes"), pin)).toBeNull();
    expect(pickHelper(other, null, pin)).toBeNull();
  });
  it("takes nothing without a pin, even when the compile equals the kept bytes", () => {
    expect(pickHelper(pinned, pinned, undefined)).toBeNull();
    expect(pickHelper(pinned, pinned, "")).toBeNull();
  });
});
