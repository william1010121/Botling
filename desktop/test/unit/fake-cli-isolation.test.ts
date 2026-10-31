// The fake CLIs write a "tidied" memory file where the prompt says; they must never do that outside the
// test's temp area, or a test aimed at a real project would overwrite its .bot/memory.md.
import { describe, expect, it } from "vitest";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { desktop, tempDir } from "../helpers";
// @ts-expect-error plain .mjs fixture
import { safeWritePath } from "../fixtures/safe-write.mjs";

describe("fake CLI write guard", () => {
  it("allows paths under the temp dir, absolute or relative to the cwd", () => {
    const dir = realpathSync(tempDir("guard"));
    mkdirSync(join(dir, ".bot"));
    expect(safeWritePath(join(dir, ".bot", "memory.md"))).toBe(join(dir, ".bot", "memory.md"));
    expect(safeWritePath(".bot/memory.md", dir)).toBe(join(dir, ".bot", "memory.md"));
  });
  it("refuses the repo, the home folder and anything outside FAKE_ROOT", () => {
    expect(() => safeWritePath(join(desktop, "..", ".bot", "memory.md"), desktop, {})).toThrow(/refuses to write outside/);
    expect(() => safeWritePath(join(desktop, ".bot", "memory.md"), desktop, {})).toThrow(/refuses/);
    expect(() => safeWritePath(join(homedir(), ".bot", "memory.md"), desktop, {})).toThrow(/refuses/);
    expect(() => safeWritePath("../escape.md", tmpdir(), { FAKE_ROOT: join(tmpdir(), "nested-root-that-does-not-exist-x") })).toThrow(/refuses/);
  });
});
