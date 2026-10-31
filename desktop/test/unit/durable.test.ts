// Atomic-file locks: a lock left by a dead process is broken; a live holder's is respected.
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "../../src/core/durable/atomic";
import { tempDir } from "../helpers";

describe("durable file locks", () => {
  it("a lock left by a dead process is broken; a live holder's is respected", () => {
    const dir = tempDir("durable");
    const store = join(dir, "jobs.json");
    writeFileSync(`${store}.lock`, JSON.stringify({ pid: 999_999, boot: "gone", at: Date.now() }));
    expect(withFileLock(store, () => 1)).toBe(1);
    writeFileSync(`${store}.lock`, JSON.stringify({ pid: process.pid, boot: "someone-else", at: Date.now() }));
    expect(() => withFileLock(store, () => 1, { timeoutMs: 200 })).toThrow(/Could not lock/);
  });
});
