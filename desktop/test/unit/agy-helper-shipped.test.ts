// The Antigravity file helper has no pinned hash: a build compiles it (scripts/package-agy-helper.mjs), ships the bytes as data, and the runtime
// accepts an installed helper only when it is byte for byte the shipped one (src/core/agent/agy-helper-trust.ts).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("packages nothing off macOS arm64 (not on another platform, not on another arch)", () => {
    for (const [platform, arch] of [["linux", "x64"], ["darwin", "x64"], ["linux", "arm64"]]) {
      const root = realpathSync(tempDir("agy-pack-other"));
      packageAgyHelper(root, { platform, arch, compile: () => { throw Error("must not compile"); } });
      expect(existsSync(join(root, "out"))).toBe(false);
    }
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

describe("after an app update the installed helper is replaced by the shipped one, not the runtime downloaded again", () => {
  /** An installer over `dest` that verifies the helper like the app does and counts what it fetches; the runtime's own files must read "server" / "harness". */
  function installerOver(dest: string, serverText = "server") {
    const download = vi.fn(async (file: string) => writeFileSync(file, "zip"));
    const extract = vi.fn(async (_a: string, folder: string) => { writeFileSync(join(folder, "agy_acp_server.par"), serverText); writeFileSync(join(folder, "localharness_external"), "harness"); });
    const validate = (command: string, workspace: string) => {
      if (readFileSync(command, "utf8") !== "server") throw Error("runtime bytes differ");
      verifyAgyFileHelper(join(dirname(command), "botling-agy-file-helper"), workspace);
    };
    return { download, extract, installer: new AgyRuntimeInstaller({ destination: dest, platform: "darwin", arch: "arm64", assertLocal: () => {}, download, extract, validate }) };
  }
  const place = () => { const root = realpathSync(tempDir("agy-update")); return { dest: join(root, "runtime"), workspace: (() => { const w = join(root, "ws"); mkdirSync(w); return w; })() }; };

  it("replaces only the helper: no download, no extract, the other runtime files untouched, no temp file left", async () => {
    const { dest, workspace } = place();
    useShippedHelperDir(build("helper of version 1"));
    const first = installerOver(dest);
    await first.installer.install(workspace);
    expect(first.download).toHaveBeenCalledTimes(1);
    useShippedHelperDir(build("helper of version 2, another Xcode"));
    const update = installerOver(dest);
    const command = await update.installer.install(workspace);
    expect(update.download).not.toHaveBeenCalled();
    expect(update.extract).not.toHaveBeenCalled();
    expect(readFileSync(join(dest, "botling-agy-file-helper"), "utf8")).toBe("helper of version 2, another Xcode");
    expect(readFileSync(command, "utf8")).toBe("server");
    expect(readFileSync(join(dest, "localharness_external"), "utf8")).toBe("harness");
    expect(readdirSync(dest).sort()).toEqual(["agy_acp_server.par", "botling-agy-file-helper", "localharness_external"]);
    // The app's own check also needs the helper executable (validateAgyRuntimePath: accessSync X_OK), or the repair would only fall back to a download.
    expect(statSync(join(dest, "botling-agy-file-helper")).mode & 0o700).toBe(0o700);
  });
  it("still downloads again when the helper is not all that is wrong (the runtime's own bytes differ)", async () => {
    const { dest, workspace } = place();
    useShippedHelperDir(build("helper of version 1"));
    await installerOver(dest).installer.install(workspace);
    writeFileSync(join(dest, "agy_acp_server.par"), "damaged");
    useShippedHelperDir(build("helper of version 2"));
    const again = installerOver(dest);
    await again.installer.install(workspace);
    expect(again.download).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dest, "agy_acp_server.par"), "utf8")).toBe("server");
    expect(readFileSync(join(dest, "botling-agy-file-helper"), "utf8")).toBe("helper of version 2");
  });
  it("without a shipped helper nothing is touched and nothing is downloaded (fail closed)", async () => {
    const { dest, workspace } = place();
    useShippedHelperDir(build("helper of version 1"));
    await installerOver(dest).installer.install(workspace);
    useShippedHelperDir(realpathSync(tempDir("agy-no-shipped")));
    const update = installerOver(dest);
    await expect(update.installer.install(workspace)).rejects.toThrow("Bundled Botling helper is missing");
    expect(update.download).not.toHaveBeenCalled();
    expect(readFileSync(join(dest, "botling-agy-file-helper"), "utf8")).toBe("helper of version 1");
  });
  it("a helper that is a symlink is not written through: the runtime is installed afresh", async () => {
    const { dest, workspace } = place();
    useShippedHelperDir(build("helper of version 1"));
    await installerOver(dest).installer.install(workspace);
    const elsewhere = join(dirname(dest), "elsewhere"); writeFileSync(elsewhere, "keep");
    rmSync(join(dest, "botling-agy-file-helper")); symlinkSync(elsewhere, join(dest, "botling-agy-file-helper"));
    useShippedHelperDir(build("helper of version 2"));
    const again = installerOver(dest);
    await again.installer.install(workspace);
    expect(readFileSync(elsewhere, "utf8")).toBe("keep");
    expect(again.download).toHaveBeenCalledTimes(1);
  });
});

describe("the helper is refused when it is not the shipped one", () => {
  it("an installed helper that differs from the shipped bytes: nothing executed", () => {
    useShippedHelperDir(build("shipped bytes"));
    const { path, workspace } = installed(Buffer.from("tampered bytes"));
    expect(() => verifyAgyFileHelper(path, workspace)).toThrow("File helper hash mismatch");
  });
  it("an empty shipped file is no helper: an empty installed file is refused too (fail closed)", () => {
    useShippedHelperDir(build(""));
    expect(() => shippedHelperBytes()).toThrow("Bundled Botling helper is missing");
    const { path, workspace } = installed(Buffer.alloc(0));
    expect(() => verifyAgyFileHelper(path, workspace)).toThrow("Bundled Botling helper is missing");
  });
  it("a build without a shipped helper refuses every helper (fail closed)", () => {
    useShippedHelperDir(realpathSync(tempDir("agy-none")));
    const { path, workspace } = installed(Buffer.from("anything"));
    expect(() => verifyAgyFileHelper(path, workspace)).toThrow("Bundled Botling helper is missing");
  });
});
