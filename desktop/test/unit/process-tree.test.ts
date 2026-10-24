// Spike 2/4: a process tree ends as a whole, including children that ignore SIGTERM.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { PosixGroupAdapter } from "../../src/core/process/tree";
import { alive, fakeCli, pidsIn, tempDir, until } from "../helpers";

describe.skipIf(process.platform === "win32")("PosixGroupAdapter", () => {
  const start = (mode: string) => {
    const dir = tempDir("tree");
    const pids = join(dir, "pids");
    const adapter = new PosixGroupAdapter();
    const managed = adapter.spawn(process.execPath, [fakeCli], { env: { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_PIDS: pids } });
    managed.child.stdin.end("go");
    return { managed, pids };
  };

  it("ends the CLI and its helper with SIGTERM", async () => {
    const { managed, pids } = start("slow");
    const all = await until(() => (pidsIn(pids).length >= 2 ? pidsIn(pids) : null), { what: "CLI and helper" });
    expect(all.every(alive)).toBe(true);
    const result = await managed.terminate({ graceMs: 2_000 });
    expect(result.forced).toBe(false);
    await until(() => all.every((pid) => !alive(pid)), { what: "all dead" });
  });

  it("force-kills a tree that ignores SIGTERM after the grace period", async () => {
    const { managed, pids } = start("stubborn");
    const all = await until(() => (pidsIn(pids).length >= 2 ? pidsIn(pids) : null), { what: "CLI and helper" });
    const began = Date.now();
    const result = await managed.terminate({ graceMs: 300 });
    expect(result.forced).toBe(true);
    expect(Date.now() - began).toBeGreaterThanOrEqual(300);
    await until(() => all.every((pid) => !alive(pid)), { what: "all dead" });
    // Terminating again is harmless and gives the same answer.
    expect(await managed.terminate()).toEqual(result);
  });
});
