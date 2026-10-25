import { afterEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { payload, verifyManifest } from "../../scripts/release-manifest.mjs";
import { acknowledgeUpdateBoot, SWAP_SCRIPT, VerifiedInstaller, writableApp } from "../../src/main/update-install";
import { settingsView } from "../../src/core/settings";
import { tempDir, until } from "../helpers";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const keypair = () => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
};
const signature = (bytes: Buffer, version: string, privateKey: ReturnType<typeof keypair>["privateKey"]) => {
  const fields = { version, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  return { ...fields, signature: sign(null, payload(fields), privateKey).toString("base64") };
};
function bundle(folder: string, version = "2.0.1", body = "exit 0", id = "io.github.william1010121.Botling2") {
  const app = join(folder, "Botling 2.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>TestApp</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const exe = join(app, "Contents", "MacOS", "TestApp");
  writeFileSync(exe, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return app;
}
async function fixture(options: { version?: string; bundleVersion?: string; id?: string; current?: string; trust?: string | null; body?: string } = {}) {
  const base = tempDir("verified-update");
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const keys = keypair();
  // Persist only throwaway keys in desktop/.tmp; never real release identity or user CLI folders.
  writeFileSync(join(base, "throwaway.key"), keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const target = bundle(join(base, "installed"), "2.0.0");
  const source = bundle(join(base, "source"), options.bundleVersion ?? options.version ?? "2.0.1", options.body ?? "exit 0", options.id);
  execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;test;BotlingUnit;", source]);
  const zip = join(base, "release.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", source, zip]);
  let bytes = readFileSync(zip);
  let manifest = signature(bytes, options.version ?? "2.0.1", keys.privateKey);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    res.end(req.url?.endsWith(".manifest.json") ? JSON.stringify(manifest) : bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/release.zip`;
  const installer = new VerifiedInstaller({
    current: options.current ?? "2.0.0", publicKey: options.trust === undefined ? keys.publicKey : options.trust,
    appPath: target, dataDir: join(base, "data"), platform: "darwin", arch: process.arch,
    fetch: (url) => fetch(url, { signal: AbortSignal.timeout(5_000) }), assetURL: () => url,
  });
  const release = { version: options.version ?? "2.0.1", name: "New", url: `https://github.com/william1010121/Botling/releases/tag/v${options.version ?? "2.0.1"}`, asset: `Botling-2-${options.version ?? "2.0.1"}-mac-${process.arch}.zip`, publishedAt: null };
  return {
    base, target, keys, installer, release, requests,
    tamper: () => { bytes = Buffer.from(bytes); bytes[100] ^= 1; },
    truncate: () => { bytes = bytes.subarray(0, bytes.length - 5); },
    oversize: () => { bytes = Buffer.concat([bytes, Buffer.from("extra")]); },
    wrongSignature: () => { manifest = signature(bytes, manifest.version, keypair().privateKey); },
    changeSignedVersion: () => { manifest = signature(bytes, "2.0.2", keys.privateKey); },
    addExternalSymlink: () => {
      symlinkSync(target, join(source, "Contents", "outside"));
      execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", source, zip]);
      bytes = readFileSync(zip); manifest = signature(bytes, manifest.version, keys.privateKey);
    },
    addUnsafeRoot: () => {
      const extra = join(base, "extra.txt"); writeFileSync(extra, "must not extract");
      execFileSync("/usr/bin/zip", ["-q", "-j", zip, extra]);
      bytes = readFileSync(zip); manifest = signature(bytes, manifest.version, keys.privateKey);
    },
    stageRoot: () => join(base, "installed", readdirSync(join(base, "installed")).find((name) => name.startsWith(".botling-update-"))!),
  };
}

describe.skipIf(process.platform !== "darwin")("verified update from a local release server", () => {
  it("valid signature/hash/size stages without changing the running app; only staged quarantine is removed", async () => {
    const f = await fixture();
    execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;old;test;", f.target]);
    await f.installer.stage(f.release);
    expect(f.installer.ready).toBe("2.0.1");
    expect(readFileSync(join(f.target, "Contents", "Info.plist"), "utf8")).toContain("2.0.0");
    expect(execFileSync("/usr/bin/xattr", [f.target], { encoding: "utf8" })).toContain("com.apple.quarantine");
    expect(execFileSync("/usr/bin/xattr", [join(f.stageRoot(), "Botling 2.app")], { encoding: "utf8" })).not.toContain("com.apple.quarantine");
    expect(existsSync(join(f.base, "data", "update-pending.json"))).toBe(false);
    f.installer.discard(); // normal quit discards; it never installs
    expect(f.installer.ready).toBeNull();
    expect(readFileSync(join(f.target, "Contents", "Info.plist"), "utf8")).toContain("2.0.0");
  });
  it.each([
    ["tampered ZIP", "tamper", "SHA-256"], ["truncated ZIP", "truncate", "size mismatch"],
    ["oversized ZIP", "oversize", "exceeds"], ["wrong key", "wrongSignature", "signature"],
    ["signed version mismatch", "changeSignedVersion", "version does not match"],
  ] as const)("rejects %s before touching the installed app", async (_, action, message) => {
    const f = await fixture(); f[action]();
    const before = readFileSync(join(f.target, "Contents", "Info.plist"));
    await expect(f.installer.stage(f.release)).rejects.toThrow(message);
    expect(readFileSync(join(f.target, "Contents", "Info.plist"))).toEqual(before);
    expect(readdirSync(join(f.base, "installed"))).toEqual(["Botling 2.app"]);
    expect(f.installer.ready).toBeNull();
  });
  it.each(["2.0.0", "1.9.0", "2.0.1"])("refuses downgrade or reinstall %s before network or mutation", async (version) => {
    const f = await fixture({ version: "2.0.1", current: version === "1.9.0" ? "2.0.0" : version });
    f.release.version = version;
    await expect(f.installer.stage(f.release)).rejects.toThrow("downgrade");
    expect(f.requests).toEqual([]);
  });
  it("missing trust fails closed before any download", async () => {
    const f = await fixture({ trust: null });
    await expect(f.installer.stage(f.release)).rejects.toThrow("trust is not configured");
    expect(f.requests).toEqual([]);
  });
  it.each([{ bundleVersion: "2.0.2" }, { id: "evil.app" }])("refuses a signed bundle with wrong identity/version %j", async (options) => {
    const f = await fixture(options);
    await expect(f.installer.stage(f.release)).rejects.toThrow("identity or version mismatch");
    expect(readdirSync(join(f.base, "installed"))).toEqual(["Botling 2.app"]);
  });
  it("rejects a correctly signed ZIP with files outside the app root", async () => {
    const f = await fixture(); f.addUnsafeRoot();
    await expect(f.installer.stage(f.release)).rejects.toThrow("Unsafe update archive paths");
    expect(readdirSync(join(f.base, "installed"))).toEqual(["Botling 2.app"]);
  });
  it("rejects signed symlinks outside the staged app before clearing quarantine", async () => {
    const f = await fixture(); f.addExternalSymlink();
    execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;test;original;", f.target]);
    await expect(f.installer.stage(f.release)).rejects.toThrow("symlink escapes");
    expect(execFileSync("/usr/bin/xattr", [f.target], { encoding: "utf8" })).toContain("com.apple.quarantine");
  });
  it("refuses restart without a verified staged update", async () => {
    const f = await fixture();
    expect(() => f.installer.restart(process.pid)).toThrow("verify the update first");
  });
  it("the real restart entrypoint starts a bounded helper only on explicit request", async () => {
    const f = await fixture({ body: 'echo $$ > "$0.pid"; exec /bin/sleep 60' });
    await f.installer.stage(f.release);
    const root = f.stageRoot();
    const old = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    const pidFile = join(f.target, "Contents", "MacOS", "TestApp.pid");
    cleanups.push(() => { old.kill("SIGKILL"); if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {} } });
    f.installer.restart(old.pid!);
    expect(f.installer.ready).toBeNull();
    const pending = JSON.parse(readFileSync(join(f.base, "data", "update-pending.json"), "utf8"));
    expect(existsSync(join(root, "previous.app"))).toBe(false);
    old.kill("SIGTERM"); await once(old, "exit");
    await until(() => existsSync(pidFile));
    expect(existsSync(join(root, "previous.app"))).toBe(true);
    expect(acknowledgeUpdateBoot(join(f.base, "data"), f.target, "2.0.1", [`--botling-update-token=${pending.token}`])).toBe(true);
    await until(() => existsSync(join(root, "result")));
    expect(readFileSync(join(root, "result"), "utf8")).toBe("booted\n");
    expect(existsSync(join(root, "previous.app"))).toBe(false);
  });
  it("detects a staged executable modified before the restart click", async () => {
    const f = await fixture(); await f.installer.stage(f.release);
    writeFileSync(join(f.stageRoot(), "Botling 2.app", "Contents", "MacOS", "TestApp"), "tampered");
    expect(() => f.installer.restart(process.pid)).toThrow("staged app changed");
    expect(existsSync(join(f.base, "data", "update-pending.json"))).toBe(false);
  });
  it("rechecks the installed version at restart to prevent a late downgrade", async () => {
    const f = await fixture(); await f.installer.stage(f.release);
    bundle(join(f.base, "installed"), "2.0.2");
    expect(() => f.installer.restart(process.pid)).toThrow("downgrade");
  });
  it("rejects App Translocation and a read-only app with Applications guidance", async () => {
    const f = await fixture();
    expect(() => writableApp(join(f.base, "AppTranslocation", "Botling 2.app"))).toThrow("Applications");
    chmodSync(f.target, 0o555);
    try { expect(() => writableApp(f.target)).toThrow("Applications"); }
    finally { chmodSync(f.target, 0o755); }
  });
});

describe("release trust and defaults", () => {
  it("defaults checks on, preserving an explicit off", () => {
    expect(settingsView({}).updateCheck).toBe(true);
    expect(settingsView({ updateCheckEnabled: false }).updateCheck).toBe(false);
  });
  it.each(["version", "sha256", "size"] as const)("authenticates signed %s", (field) => {
    const keys = keypair(); const manifest = signature(Buffer.from("zip"), "2.0.1", keys.privateKey);
    expect(verifyManifest(manifest, keys.publicKey)).toEqual(manifest);
    const altered = { ...manifest, [field]: field === "version" ? "2.0.2" : field === "size" ? 99 : "0".repeat(64) };
    expect(() => verifyManifest(altered, keys.publicKey)).toThrow("signature");
  });
});

// Real /bin/sh, renames and fake app executables on SSD. The failed app is killed and reaped.
describe.skipIf(process.platform !== "darwin")("relaunch transaction", () => {
  async function transaction(mode: "boot" | "crash" | "hang") {
    const base = tempDir("update-swap");
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const target = bundle(join(base, "installed"), "2.0.0");
    const root = join(base, "installed", ".botling-update-test");
    mkdirSync(root);
    const marker = join(root, "boot.ok"), pidFile = join(root, "new.pid"), token = "test-token";
    const staged = bundle(root, "2.0.1", `echo $$ > '${pidFile}'\n${mode === "crash" ? "exit 1" : `${mode === "boot" ? `printf '${token}' > '${marker}'` : ":"}\nexec /bin/sleep 60`}`);
    const script = join(root, "swap.sh"); writeFileSync(script, SWAP_SCRIPT);
    // A real old PID proves the helper cannot replace a running app before it exits.
    const old = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    const helper = spawn("/bin/sh", [script, String(old.pid), target, staged, join(root, "previous.app"), marker, token, "TestApp", "10", "0.1"], { stdio: "pipe" });
    const finished = once(helper, "exit");
    cleanups.push(async () => {
      old.kill("SIGKILL"); helper.kill("SIGKILL");
      if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {} }
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(readFileSync(join(target, "Contents", "Info.plist"), "utf8")).toContain("2.0.0");
    old.kill("SIGTERM"); await once(old, "exit");
    await until(() => existsSync(join(root, "result")), { timeout: 10_000 });
    const [code] = await finished;
    return { base, root, target, code, marker, token, pidFile };
  }
  it("only commits after new boot, then removes previous app and exits helper", async () => {
    const t = await transaction("boot");
    expect(t.code).toBe(0);
    expect(readFileSync(join(t.target, "Contents", "Info.plist"), "utf8")).toContain("2.0.1");
    expect(existsSync(join(t.root, "previous.app"))).toBe(false);
    expect(readFileSync(join(t.root, "result"), "utf8")).toBe("booted\n");
  });
  it.each(["crash", "hang"] as const)("restores previous app after new app %s", async (mode) => {
    const t = await transaction(mode);
    expect(t.code).toBe(13);
    expect(readFileSync(join(t.target, "Contents", "Info.plist"), "utf8")).toContain("2.0.0");
    expect(existsSync(join(t.root, "failed.app"))).toBe(true);
    expect(readFileSync(join(t.root, "result"), "utf8")).toBe("rolled-back\n");
    expect(() => process.kill(Number(readFileSync(t.pidFile, "utf8")), 0)).toThrow();
  });
  it("boot receipt requires exact token, installed path and version", () => {
    const base = tempDir("update-receipt");
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const target = bundle(base), root = join(base, ".botling-update-test"); mkdirSync(root);
    writeFileSync(join(base, "update-pending.json"), JSON.stringify({ root, token: "token", target, version: "2.0.1" }));
    expect(acknowledgeUpdateBoot(base, target, "2.0.1", ["--botling-update-token=wrong"])).toBe(false);
    expect(acknowledgeUpdateBoot(base, target, "2.0.0", ["--botling-update-token=token"])).toBe(false);
    expect(existsSync(join(root, "boot.ok"))).toBe(false);
    expect(acknowledgeUpdateBoot(base, target, "2.0.1", ["--botling-update-token=token"])).toBe(true);
    expect(readFileSync(join(root, "boot.ok"), "utf8")).toBe("token");
  });
});


describe("operator release scripts in a throwaway HOME only", () => {
  function scriptFixture() {
    const base = tempDir("release-script");
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(join(base, "scripts"));
    for (const file of ["release-sign.mjs", "release-manifest.mjs"]) cpSync(resolve("scripts", file), join(base, "scripts", file));
    const env = { ...process.env, HOME: base, BOTLING_RELEASE_KEY: "" };
    return { base, env, script: join(base, "scripts", "release-sign.mjs") };
  }
  it("explicit keygen creates a mode-600 key and refuses to replace it", () => {
    const f = scriptFixture();
    execFileSync(process.execPath, [f.script, "keygen"], { env: f.env });
    const key = join(f.base, ".botling-release", "ed25519.key");
    const before = readFileSync(key);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(() => execFileSync(process.execPath, [f.script, "keygen"], { env: f.env, stdio: "pipe" })).toThrow();
    expect(readFileSync(key)).toEqual(before);
  });
  it("CI signs with BOTLING_RELEASE_KEY, matching embedded public config", () => {
    const f = scriptFixture(), keys = keypair();
    writeFileSync(join(f.base, "release-config.json"), JSON.stringify({ publicKey: keys.publicKey }));
    const zip = join(f.base, "test.zip"), bytes = Buffer.from("test release bytes"); writeFileSync(zip, bytes);
    execFileSync(process.execPath, [f.script, "sign", "2.0.1", zip], { env: { ...f.env, BOTLING_RELEASE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() } });
    const manifest = JSON.parse(readFileSync(`${zip}.manifest.json`, "utf8"));
    expect(verifyManifest(manifest, keys.publicKey).size).toBe(bytes.length);
    expect(existsSync(join(f.base, ".botling-release"))).toBe(false);
  });
  it("explicit release-build mode fails before bundling when trust is unconfigured", () => {
    const result = spawnSync(process.execPath, [resolve("build.mjs")], { env: { ...process.env, BOTLING_RELEASE_BUILD: "1" }, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Release build requires an explicit Ed25519 public key");
  });
  it("refuses a signing key that differs from the configured public trust", () => {
    const f = scriptFixture(), keys = keypair();
    writeFileSync(join(f.base, "release-config.json"), JSON.stringify({ publicKey: keypair().publicKey }));
    const zip = join(f.base, "test.zip"); writeFileSync(zip, "bytes");
    expect(() => execFileSync(process.execPath, [f.script, "sign", "2.0.1", zip], { env: { ...f.env, BOTLING_RELEASE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, stdio: "pipe" })).toThrow();
    expect(existsSync(`${zip}.manifest.json`)).toBe(false);
  });
});
