import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { rendererFiles } from "../../src/main/renderer-loading";
import { rendererAppData, rendererConfigPath, writeRendererConfiguration } from "../../renderer-config.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "botling-renderer-config-")); roots.push(home);
  const directory = join(home, "stable-renderer"), env = { ...process.env, HOME: home,
    APPDATA: join(home, "roaming"), XDG_CONFIG_HOME: join(home, "config") };
  const appData = rendererAppData(process.platform, env, home), path = rendererConfigPath(appData);
  mkdirSync(directory);
  for (const name of ["index.html", "renderer.js", "styles.css", "chat.html", "chat.js", "chat.css", "frame.css"])
    writeFileSync(join(directory, name), "placeholder");
  const root = join(home, "installed-version-one"), next = join(home, "installed-version-two");
  const launch = (appRoot = root, packaged = true, trial = true, args: string[] = []) => {
    const warnings: string[] = [];
    return { files: rendererFiles(appRoot, packaged, trial, args, { appData, warn: text => warnings.push(text) }), warnings };
  };
  const command = (...args: string[]) => spawnSync(process.execPath, [resolve("scripts/renderer-configure.mjs"), ...args], { env, encoding: "utf8" });
  return { home, root, next, directory, env, appData, path, launch, command };
}
it("normal dev-trial launches reuse explicit configuration across installed app replacement, and disable restores bundles", () => {
  const f = fixture();
  expect(f.launch().files.directory).toBe(join(f.root, "out/renderer"));
  const enable = f.command("--enable", `--outdir=${f.directory}`);
  expect(enable.status, enable.stderr).toBe(0);
  expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual({ version: 1, enabled: true, directory: f.directory });
  for (const appRoot of [f.root, f.next]) {
    const result = f.launch(appRoot);
    expect(result.files).toEqual({ directory: f.directory, development: true });
    expect(result.warnings).toEqual([]);
  }
  // Source/test instances keep their checkout assets unless explicitly launched with an override.
  expect(f.launch(f.root, false, false).files.directory).toBe(join(f.root, "out/renderer"));
  expect(f.launch(f.root, false, false, [`--botling-renderer-dir=${f.directory}`]).files.directory).toBe(f.directory);
  const status = f.command("--status");
  expect(status.status).toBe(0); expect(status.stdout).toContain(f.directory);
  const disable = f.command("--disable");
  expect(disable.status, disable.stderr).toBe(0);
  expect(f.launch(f.next).files).toEqual({ directory: join(f.next, "out/renderer"), development: false });
  expect(existsSync(join(f.directory, "renderer.js"))).toBe(true);
});
it("renderer build without arguments uses the explicitly configured stable output, independent of checkout output", () => {
  const f = fixture(); writeRendererConfiguration(f.appData, f.directory);
  const result = spawnSync(process.execPath, [resolve("scripts/renderer-dev.mjs")], { env: f.env, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(f.directory);
  expect(readFileSync(join(f.directory, "renderer.js"), "utf8").length).toBeGreaterThan(1000);
  expect(readFileSync(join(f.directory, "index.html"), "utf8")).toContain('<div id="root">');
  expect(f.launch(f.next).files.directory).toBe(f.directory);
});
it("renderer watch without launch arguments publishes to the saved stable output and exits without starting an app", async () => {
  const f = fixture(); writeRendererConfiguration(f.appData, f.directory);
  const watcher = spawn(process.execPath, [resolve("scripts/renderer-dev.mjs"), "--watch"], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(watcher, "close");
  let stdout = "", stderr = "";
  watcher.stdout.on("data", chunk => { stdout += chunk; });
  watcher.stderr.on("data", chunk => { stderr += chunk; });
  try {
    await expect.poll(() => stdout, { timeout: 5000 }).toContain(`[renderer] ready: ${f.directory}`);
    expect(stderr).toBe("");
    expect(f.launch(f.next).files.directory).toBe(f.directory);
  } finally {
    watcher.kill("SIGTERM");
    await closed;
  }
});
it("missing, malformed, unsupported and unavailable configured output falls back on ordinary dev-trial launch", () => {
  const f = fixture();
  expect(f.launch().warnings).toEqual([]);
  mkdirSync(resolve(f.path, ".."), { recursive: true });
  for (const contents of ["{bad json", JSON.stringify({ version: 2, enabled: true, directory: f.directory }),
    JSON.stringify({ version: 1, enabled: "true", directory: f.directory }),
    JSON.stringify({ version: 1, enabled: true, directory: "relative/worktree" }),
    JSON.stringify({ version: 1, enabled: true, directory: join(f.home, "deleted-output") })]) {
    writeFileSync(f.path, contents);
    const result = f.launch();
    expect(result.files).toEqual({ directory: join(f.root, "out/renderer"), development: false });
    expect(result.warnings).toHaveLength(1);
  }
  writeRendererConfiguration(f.appData, f.directory);
  rmSync(join(f.directory, "chat.js"));
  expect(f.launch().warnings[0]).toContain("Missing renderer asset chat.js");
  expect(f.launch().files.directory).toBe(join(f.root, "out/renderer"));
});
it("ordinary production ignores both a valid opt-in and malformed config; explicit developer launch flag wins", () => {
  const f = fixture(); writeRendererConfiguration(f.appData, f.directory);
  for (const config of [readFileSync(f.path, "utf8"), "{bad json"]) {
    writeFileSync(f.path, config);
    const production = f.launch(f.root, true, false, [`--botling-renderer-dir=${f.directory}`]);
    expect(production.files).toEqual({ directory: join(f.root, "out/renderer"), development: false });
    expect(production.warnings).toEqual([]);
  }
  const explicit = f.launch(f.root, true, true, [`--botling-renderer-dir=${f.directory}`]);
  expect(explicit.files.directory).toBe(f.directory); expect(explicit.warnings).toEqual([]);
});
it("invalid enable commands preserve an existing opt-in instead of silently selecting another checkout", () => {
  const f = fixture(); writeRendererConfiguration(f.appData, f.directory);
  const before = readFileSync(f.path, "utf8");
  for (const args of [["--enable"], ["--enable", "--outdir=relative"], ["--enable", "--outdir=/nonexistent/renderer"], ["--disable", "--outdir=/nonexistent"]]) {
    expect(f.command(...args).status).not.toBe(0);
    expect(readFileSync(f.path, "utf8")).toBe(before);
  }
});
it("Node commands locate the same platform app-data root as the native loader", () => {
  expect(rendererAppData("darwin", {}, "/home/dev")).toBe("/home/dev/Library/Application Support");
  expect(rendererAppData("linux", { XDG_CONFIG_HOME: "/custom/config" }, "/home/dev")).toBe("/custom/config");
  expect(rendererAppData("linux", {}, "/home/dev")).toBe("/home/dev/.config");
  expect(rendererAppData("win32", { APPDATA: "/custom/roaming" }, "/home/dev")).toBe("/custom/roaming");
});
