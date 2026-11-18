// The Antigravity file helper has no pinned hash: a build compiles it (scripts/package-agy-helper.mjs), ships the bytes as data, and the runtime
// accepts an installed helper only when it is byte for byte the shipped one (src/core/agent/agy-helper-trust.ts).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shippedHelperBytes, shippedHelperSha, useShippedHelperDir } from "../../src/core/agent/agy-helper-trust";
import { verifyAgyFileHelper } from "../../src/core/agent/agy-mcp";
import { AgyRuntimeInstaller } from "../../src/core/agy-runtime-install";
import { packageAgyHelper } from "../../scripts/package-agy-helper.mjs";
import { tempDir } from "../helpers";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const original = realpathSync(join(__dirname, "../../src/core/agent"));
afterEach(() => useShippedHelperDir(original));

/** A build as another Xcode would make it: whatever bytes its compiler wrote, and a verify that accepts them. */
function build(bytes: string) {
  const root = realpathSync(tempDir("agy-pack"));
  packageAgyHelper(root, { platform: "darwin", arch: "arm64", compile: (_root: string, file: string) => writeFileSync(file, bytes), verify: () => {} });
  return join(root, "out/core");
}
function installed(bytes: Buffer) {
  const dir = realpathSync(tempDir("agy-installed"));
  const workspace = join(dir, "workspace"); mkdirSync(workspace);
  const path = join(dir, "botling-agy-file-helper");
  writeFileSync(path, bytes, { mode: 0o700 });
  return { path, workspace };
}

describe("a release build does not stop on the compiler's output", () => {
  it("packages whatever the compiler wrote, with BOTLING_RELEASE_BUILD=1 and no CI skip", () => {
    const before = process.env.BOTLING_RELEASE_BUILD;
    process.env.BOTLING_RELEASE_BUILD = "1";
    try {
      for (const bytes of ["bytes of one Xcode", "bytes of another Xcode"]) {
        const out = build(bytes);
        expect(Buffer.from(readFileSync(join(out, "agy-file-helper.base64"), "utf8"), "base64").toString()).toBe(bytes);
        expect(readdirSync(out)).toEqual(["agy-file-helper.base64"]);
      }
    } finally { if (before === undefined) delete process.env.BOTLING_RELEASE_BUILD; else process.env.BOTLING_RELEASE_BUILD = before; }
  });
  it("packages nothing off macOS arm64", () => {
    const root = realpathSync(tempDir("agy-pack-linux"));
    packageAgyHelper(root, { platform: "linux", arch: "x64", compile: () => { throw Error("must not compile"); } });
    expect(existsSync(join(root, "out"))).toBe(false);
  });
  it("a failed codesign verify still stops the build (the compiled bytes must be a valid signed binary)", () => {
    const root = realpathSync(tempDir("agy-pack-bad"));
    expect(() => packageAgyHelper(root, { platform: "darwin", arch: "arm64", compile: (_r: string, f: string) => writeFileSync(f, "x"), verify: () => { throw Error("not signed"); } })).toThrow("not signed");
    expect(existsSync(join(root, "out/core/agy-file-helper.base64"))).toBe(false);
  });
});

describe("the helper loads at runtime when it is the shipped one", () => {
  it("a freshly compiled helper (any bytes) is accepted from the folder the build wrote, and the installer hands out exactly those bytes", () => {
    const out = build("freshly compiled helper bytes");
    useShippedHelperDir(out);
    expect(shippedHelperBytes().toString()).toBe("freshly compiled helper bytes");
    const { path, workspace } = installed(Buffer.from("freshly compiled helper bytes"));
    expect(() => verifyAgyFileHelper(path, workspace)).not.toThrow();
    expect(shippedHelperSha()).toBe(sha(Buffer.from("freshly compiled helper bytes")));
  });
  it("the installer writes the shipped bytes into the runtime folder, where they verify", async () => {
    useShippedHelperDir(build("shipped bytes"));
    const dest = join(realpathSync(tempDir("agy-dest")), "runtime");
    const done = new AgyRuntimeInstaller({
      destination: dest, platform: "darwin", arch: "arm64", assertLocal: () => {},
      download: async (file: string) => writeFileSync(file, "zip"),
      extract: async (_a: string, folder: string) => { for (const n of ["agy_acp_server.par", "localharness_external"]) writeFileSync(join(folder, n), n); },
      validate: (command: string, workspace: string) => verifyAgyFileHelper(join(dirname(command), "botling-agy-file-helper"), workspace),
    });
    const workspace = realpathSync(tempDir("agy-ws"));
    await done.install(workspace);
    expect(readFileSync(join(dest, "botling-agy-file-helper"), "utf8")).toBe("shipped bytes");
  });
});

describe("the helper is refused when it is not the shipped one", () => {
  it("an installed helper that differs from the shipped bytes: nothing executed", () => {
    useShippedHelperDir(build("shipped bytes"));
    const { path, workspace } = installed(Buffer.from("tampered bytes"));
    expect(() => verifyAgyFileHelper(path, workspace)).toThrow("File helper hash mismatch");
  });
  it("a build without a shipped helper refuses every helper (fail closed)", () => {
    useShippedHelperDir(realpathSync(tempDir("agy-none")));
    const { path, workspace } = installed(Buffer.from("anything"));
    expect(() => verifyAgyFileHelper(path, workspace)).toThrow("Bundled Botling helper is missing");
  });
});
