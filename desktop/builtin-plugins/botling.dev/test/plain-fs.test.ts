// botlingd's plugin host is an Electron utility process, where node:fs reads app.asar as a folder (2026-11-17). swap.ts reads the
// bundle with Electron's `original-fs`, loaded through createRequire; this pins that the module it loads is the one the asar is
// read with (without it, every Electron run judged installs by a clock). Electron itself is not started: createRequire is faked.
import { describe, expect, it, vi } from "vitest";
import * as realFs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tempDir } from "../../../test/helpers";

const plain = { file: "" };
vi.mock("node:module", async (original) => {
  const actual = await original<typeof import("node:module")>();
  // `original-fs`: the real fs, except that app.asar reads come from `plain.file` (so the test sees which fs was used).
  const originalFs = {
    ...realFs,
    statSync: (file: string, ...rest: unknown[]) => (realFs.statSync as (...args: unknown[]) => realFs.Stats)(String(file).endsWith("app.asar") ? plain.file : file, ...rest),
    openSync: (file: string, ...rest: unknown[]) => (realFs.openSync as (...args: unknown[]) => number)(String(file).endsWith("app.asar") ? plain.file : file, ...rest),
  };
  return { ...actual, createRequire: (url: string | URL) => { const req = actual.createRequire(url); return Object.assign((id: string) => id === "original-fs" ? originalFs : req(id), req); } };
});

describe("the bundle is read with original-fs when it is there", () => {
  it("asarSha256 hashes what original-fs reads, not what node:fs reads", async () => {
    const root = tempDir("plain-fs");
    const resources = join(root, "Botling 3.app", "Contents", "Resources");
    realFs.mkdirSync(resources, { recursive: true });
    realFs.writeFileSync(join(resources, "app.asar"), "what node:fs sees");
    plain.file = join(root, "plain.bin");
    realFs.writeFileSync(plain.file, "what original-fs sees");
    const { asarSha256 } = await import("../src/swap");
    expect(asarSha256(join(root, "Botling 3.app"))).toBe(createHash("sha256").update("what original-fs sees").digest("hex"));
  });
});
