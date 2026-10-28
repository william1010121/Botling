// Installing a developer build without a restart (main/hot-install.ts, docs/core-hot-swap.md "Installing a
// build"): what counts as kernel, the plan, copies out of app.asar, the bundle on disk, and the order and
// rollback of applying. Fake bundles in temp folders (real app.asar archives, real mv/ditto); the core swap
// and page reloads are fakes. No Electron, no windows.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createPackage } from "@electron/asar";
import { tempDir } from "../helpers";
import {
  HotInstaller, applyHot, bundlePrints, classify, installBundle, planInstall, plistValues, restoreBundle, stageParts,
  type ApplyPorts, type Run,
} from "../../src/main/hot-install";
import type { SwapOutcome } from "../../src/main/core-swap";
import { parsePlan, parseReport, planText, type HotReport } from "../../src/hot-install-plan";

const execute = promisify(execFile);
const run: Run = (file, args) => execute(file, args);

const BASE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "botling-desktop", version: "2.0.0-dev.1", main: "out/main/main.cjs", botlingDevTrial: true, botlingStorageContract: { version: 1, epoch: 2 } }),
  "out/main/main.cjs": "main v1",
  "out/preload/preload.cjs": "preload v1",
  "out/preload/editor-host.cjs": "editor host v1",
  "out/core/main.cjs": "core v1",
  "out/core/storage-contract.json": JSON.stringify({ version: 1, epoch: 2 }),
  "out/host/host.mjs": "host v1",
  "out/host/host-utility.mjs": "host utility v1",
  "out/host/check-plugin.cjs": "check v1",
  "out/web-extractors/gemini.js": "extractor v1",
  "out/renderer/index.html": "<html>shell</html>",
  "out/renderer/renderer.js": "shell v1",
  "out/renderer/styles.css": "shell css v1",
  "out/renderer/chat.html": "<html>chat</html>",
  "out/renderer/chat.js": "chat v1",
  "out/renderer/chat.css": "chat css v1",
  "out/renderer/frame.css": "frame v1",
  "out/renderer/plugins/ccb-latex/katex.min.css": "katex",
};

interface Spec { version?: string; files?: Record<string, string | null>; electron?: string; asar?: boolean; icon?: string }

/** A Botling 2.app as electron-builder lays it out (only what the comparison reads). */
async function fakeBundle(dir: string, spec: Spec = {}): Promise<string> {
  const app = join(dir, "Botling 2.app");
  const contents = join(app, "Contents");
  const version = spec.version ?? "2.0.0-dev.1";
  const put = (path: string, text: string, mode = 0o644) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, { mode }); };
  put(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>io.github.william1010121.Botling2</string>
  <key>CFBundleExecutable</key><string>Botling 2</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>BotlingGitCommit</key><string>${version}abc</string>
  <key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>${version}-hash</string></dict></dict>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>`);
  put(join(contents, "MacOS", "Botling 2"), `launcher signed for ${version}`, 0o755);
  put(join(contents, "_CodeSignature", "CodeResources"), `seal ${version}`);
  const framework = join(contents, "Frameworks", "Electron Framework.framework", "Versions", "A");
  put(join(framework, "Electron Framework"), spec.electron ?? "electron 44.9.3", 0o755);
  put(join(framework, "Resources", "Info.plist"), `<plist><dict><key>CFBundleVersion</key><string>${(spec.electron ?? "44.9.3").replace(/\D+/g, ".")}</string></dict></plist>`);
  const helper = join(contents, "Frameworks", "Botling 2 Helper (Renderer).app", "Contents");
  put(join(helper, "Info.plist"), `<plist><dict><key>CFBundleVersion</key><string>${version}</string></dict></plist>`);
  put(join(helper, "MacOS", "Botling 2 Helper (Renderer)"), `helper signed for ${version}`, 0o755);
  put(join(contents, "Resources", "icon.icns"), spec.icon ?? "icon");
  const files: Record<string, string | null> = { ...BASE_FILES, ...spec.files };
  files["package.json"] = JSON.stringify({ ...JSON.parse(files["package.json"]!), version });
  const appFiles = spec.asar === false ? join(contents, "Resources", "app") : join(dir, "app-src");
  for (const [path, text] of Object.entries(files)) if (text !== null) put(join(appFiles, ...path.split("/")), text);
  if (spec.asar !== false) {
    await createPackage(appFiles, join(contents, "Resources", "app.asar"));
    fs.rmSync(appFiles, { recursive: true, force: true });
  }
  return app;
}

async function pair(running: Spec, incoming: Spec) {
  const root = tempDir("hot-install");
  const a = await fakeBundle(join(root, "Applications"), running);
  const b = await fakeBundle(join(root, "dist"), { version: "2.0.0-dev.2", ...incoming });
  return { root, running: a, incoming: b, plan: planInstall(await bundlePrints(a, fs), await bundlePrints(b, fs)) };
}

describe("what counts as kernel", () => {
  it("classifies app files: main, preloads, package.json and unknown files are kernel; core, chat page and shell are parts", () => {
    expect(classify("out/main/main.cjs")).toEqual({ kernel: "main process" });
    expect(classify("out/preload/editor-host.cjs")).toEqual({ kernel: "preloads" });
    expect(classify("package.json")).toEqual({ kernel: "package.json" });
    expect(classify("out/core/addon.node")).toEqual({ kernel: "native modules" });
    expect(classify("out/something/new.js")).toEqual({ kernel: "other app files" });
    expect(classify("out/core/main.cjs")).toEqual({ part: "core" });
    expect(classify("out/host/host-utility.mjs")).toEqual({ part: "core" });
    expect(classify("out/web-extractors/gemini.js")).toEqual({ part: "core" });
    expect(classify("out/renderer/chat.js")).toEqual({ part: "chat" });
    expect(classify("out/renderer/plugins/ccb-latex/fonts/KaTeX_Main-Regular.woff2")).toEqual({ part: "chat" });
    expect(classify("out/renderer/renderer.js")).toEqual({ part: "shell" });
    expect(classify("out/core/main.cjs.map")).toBeNull();
  });

  it("Info.plist: per-build keys and the asar integrity hash do not count", () => {
    const values = plistValues(`<plist><dict><key>CFBundleIdentifier</key><string>x</string><key>CFBundleVersion</key><string>9</string>
      <key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>abc</string></dict></dict>
      <key>LSUIElement</key><false/></dict></plist>`);
    expect(values).toEqual({ CFBundleIdentifier: "x", LSUIElement: "false" });
  });

  it("a new version with only the core and chat page changed is hot: core, then chat page", async () => {
    const { plan } = await pair({}, { files: { "out/core/main.cjs": "core v2", "out/renderer/chat.js": "chat v2" } });
    expect(plan).toEqual({ mode: "hot", parts: ["core", "chat"] });
    expect(planText(plan)).toBe("hot-apply: core, chat page");
  });

  it("only the shell: hot, shell; nothing but the version: hot with no parts", async () => {
    expect((await pair({}, { files: { "out/renderer/renderer.js": "shell v2" } })).plan).toEqual({ mode: "hot", parts: ["shell"] });
    const same = (await pair({}, {})).plan;
    expect(same).toEqual({ mode: "hot", parts: [] });
    expect(planText(same)).toMatch(/nothing besides the version/);
  });

  it("works the same for an unpacked Resources/app folder", async () => {
    expect((await pair({ asar: false }, { asar: false, files: { "out/host/host.mjs": "host v2" } })).plan).toEqual({ mode: "hot", parts: ["core"] });
  });

  it("main process, preloads, package.json fields, Electron, other resources or native modules: restart, naming what changed", async () => {
    const restart = async (incoming: Spec) => (await pair({}, incoming)).plan;
    expect(await restart({ files: { "out/main/main.cjs": "main v2", "out/core/main.cjs": "core v2" } })).toEqual({ mode: "restart", reasons: ["kernel changed: main process"] });
    expect(await restart({ files: { "out/preload/preload.cjs": "preload v2" } })).toEqual({ mode: "restart", reasons: ["kernel changed: preloads"] });
    expect(await restart({ files: { "package.json": JSON.stringify({ name: "botling-desktop", main: "out/main/main.cjs" }) } })).toEqual({ mode: "restart", reasons: ["kernel changed: package.json"] });
    expect(await restart({ electron: "electron 45.0.0" })).toEqual({ mode: "restart", reasons: ["kernel changed: Electron"] });
    expect(await restart({ icon: "new icon" })).toEqual({ mode: "restart", reasons: ["kernel changed: app resources"] });
    expect(await restart({ files: { "out/core/fast.node": "binary" } })).toEqual({ mode: "restart", reasons: ["kernel changed: native modules"] });
    expect(planText({ mode: "restart", reasons: ["kernel changed: main process"] })).toBe("restart (kernel changed: main process)");
  });

  it("plans and reports cross the process boundary only in their known shapes", () => {
    expect(parsePlan({ mode: "hot", parts: ["shell", "core", "x"] })).toBeNull();
    expect(parsePlan({ mode: "hot", parts: ["shell", "core"] })).toEqual({ mode: "hot", parts: ["core", "shell"] });
    expect(parsePlan({ mode: "restart", reasons: ["a", 3] })).toEqual({ mode: "restart", reasons: ["a"] });
    expect(parseReport({ ok: true, applied: ["core"], disk: "installed", requester: "DEV", note: "", from: "a", to: "b" })).toMatchObject({ ok: true, applied: ["core"] });
    expect(parseReport({ ok: true, applied: ["core"], disk: "elsewhere", requester: "DEV" })).toBeNull();
  });
});

describe("copies and the bundle on disk", () => {
  it("copies the changed parts out of app.asar, checked against the compared build; the chat page brings the whole renderer", async () => {
    const { root, incoming } = await pair({}, {});
    const prints = await bundlePrints(incoming, fs);
    const core = await stageParts(incoming, prints, ["core"], join(root, "hot-builds"), fs, "1");
    expect(core.core).toBe(join(root, "hot-builds", "1", "core", "main.cjs"));
    expect(readFileSync(core.core!, "utf8")).toBe("core v1");
    expect(readFileSync(join(core.dir, "host", "host-utility.mjs"), "utf8")).toBe("host utility v1");
    expect(core.renderer).toBeUndefined();
    const chat = await stageParts(incoming, prints, ["chat"], join(root, "hot-builds"), fs, "2");
    expect(chat.renderer).toBe(join(root, "hot-builds", "2", "renderer"));
    expect(existsSync(join(chat.renderer!, "renderer.js")) && existsSync(join(chat.renderer!, "chat.js"))).toBe(true);
    expect(existsSync(join(chat.dir, "core"))).toBe(false);
    // Rebuilt since it was compared: refused, nothing left half-copied.
    const stale = { ...prints, files: { ...prints.files, core: { ...prints.files.core, "core/main.cjs": "0".repeat(64) } } };
    await expect(stageParts(incoming, stale, ["core"], join(root, "hot-builds"), fs, "3")).rejects.toThrow(/changed since the build was compared/);
    expect(existsSync(join(root, "hot-builds", "3"))).toBe(false);
  });

  it("installs the bundle with the old one moved to a backup, verified; a copy that differs puts the old one back", async () => {
    const { root, running, incoming } = await pair({}, { files: { "out/core/main.cjs": "core v2" } });
    const newPrints = await bundlePrints(incoming, fs);
    const oldPrints = await bundlePrints(running, fs);
    const backup = join(root, "backups", "old.hot.app");
    await installBundle(incoming, running, backup, newPrints, fs, run);
    expect((await bundlePrints(running, fs)).parts.core).toBe(newPrints.parts.core);
    expect((await bundlePrints(backup, fs)).parts.core).toBe(oldPrints.parts.core);
    await restoreBundle(running, backup, run);
    expect((await bundlePrints(running, fs)).parts.core).toBe(oldPrints.parts.core);
    expect(existsSync(backup)).toBe(false);
    const wrong = { ...newPrints, parts: { ...newPrints.parts, core: "different" } };
    await expect(installBundle(incoming, running, backup, wrong, fs, run)).rejects.toThrow(/differs from the build/);
    expect((await bundlePrints(running, fs)).parts.core).toBe(oldPrints.parts.core);
    expect(existsSync(backup)).toBe(false);
  });
});

function fakePorts(over: Partial<ApplyPorts> = {}) {
  const calls: string[] = [];
  let script = "/app/out/core/main.cjs";
  let renderer = "/app/out/renderer";
  const ports: ApplyPorts = {
    stage: async (parts) => { calls.push(`stage ${parts.join(",")}`); return { core: "/data/hot-builds/1/core/main.cjs", ...(parts.some((part) => part !== "core") ? { renderer: "/data/hot-builds/1/renderer" } : {}) }; },
    install: async () => { calls.push("install"); },
    restore: async () => { calls.push("restore"); },
    coreScript: () => script,
    swapCore: async (next): Promise<SwapOutcome> => { calls.push(`swap ${next}`); script = next; return { ok: true, script: next, entries: 1, interrupted: [], ms: 5 }; },
    useRenderer: (dir) => { calls.push(`renderer ${dir}`); const before = renderer; renderer = dir; return before; },
    reloadChat: async () => { calls.push("reload chat"); return true; },
    reloadShell: async () => { calls.push("reload shell"); return true; },
    log: () => {},
    ...over,
  };
  return { calls, ports };
}

describe("applying", () => {
  it("kernel unchanged: copies, installs on disk, then core swap, chat page reload, shell reload, in that order", async () => {
    const { calls, ports } = fakePorts();
    expect(await applyHot(["core", "chat", "shell"], ports)).toEqual({ ok: true, applied: ["core", "chat", "shell"], disk: "installed" });
    expect(calls).toEqual(["stage core,chat,shell", "install", "swap /data/hot-builds/1/core/main.cjs", "renderer /data/hot-builds/1/renderer", "reload chat", "reload shell"]);
  });

  it("only what changed: a core-only build reloads no page; a chat-only build swaps no core and leaves the shell alone", async () => {
    const core = fakePorts();
    expect(await applyHot(["core"], core.ports)).toMatchObject({ ok: true, applied: ["core"] });
    expect(core.calls).toEqual(["stage core", "install", "swap /data/hot-builds/1/core/main.cjs"]);
    const chat = fakePorts();
    expect(await applyHot(["chat"], chat.ports)).toMatchObject({ ok: true, applied: ["chat"] });
    expect(chat.calls).toEqual(["stage chat", "install", "renderer /data/hot-builds/1/renderer", "reload chat"]);
  });

  it("a failed chat reload does not activate the new shell or report success", async () => {
    let loads = 0;
    const { calls, ports } = fakePorts({ reloadChat: async () => { calls.push("reload chat"); return ++loads > 1; } });
    expect(await applyHot(["chat", "shell"], ports)).toMatchObject({ ok: false, applied: [], disk: "restored" });
    expect(calls).not.toContain("reload shell");
    expect(calls).toContain("restore");
  });

  it("the core's self-check fails: the old core stays, no page is touched, the bundle on disk is put back", async () => {
    const { calls, ports } = fakePorts({ swapCore: async (next) => { calls.push(`swap ${next}`); return { ok: false, stage: "self-check", error: "it exited (1): SyntaxError" }; } });
    const result = await applyHot(["core", "chat"], ports);
    expect(result).toEqual({ ok: false, applied: [], error: "the new core failed its self-check (it exited (1): SyntaxError)", disk: "restored" });
    expect(calls).toEqual(["stage core,chat", "install", "swap /data/hot-builds/1/core/main.cjs", "restore"]);
  });

  it("a bundle that cannot be put back is reported as needing a restart", async () => {
    const { ports } = fakePorts({
      swapCore: async () => ({ ok: false, stage: "start", error: "no answer", rolledBack: true }),
      restore: async () => { throw new Error("permission denied"); },
    });
    expect(await applyHot(["core"], ports)).toEqual({ ok: false, applied: [], error: "the new core did not come up (no answer)", disk: "stuck" });
  });

  it("a shell that does not come up: renderer, core and bundle all go back", async () => {
    let shellLoads = 0;
    const { calls, ports } = fakePorts({ reloadShell: async () => { calls.push("reload shell"); return ++shellLoads > 1; } });
    const result = await applyHot(["core", "shell"], ports);
    expect(result).toEqual({ ok: false, applied: [], error: "the new shell did not come up", disk: "restored" });
    expect(calls).toEqual([
      "stage core,shell", "install", "swap /data/hot-builds/1/core/main.cjs", "renderer /data/hot-builds/1/renderer", "reload shell",
      "renderer /app/out/renderer", "reload shell", "swap /app/out/core/main.cjs", "restore",
    ]);
  });

  it("copying or installing on disk fails: nothing was applied, nothing to put back", async () => {
    const copy = fakePorts({ stage: async () => { throw new Error("ENOSPC"); } });
    expect(await applyHot(["core"], copy.ports)).toEqual({ ok: false, applied: [], error: "could not copy the new build's files: ENOSPC", disk: "untouched" });
    const disk = fakePorts({ install: async () => { throw new Error("read-only volume"); } });
    expect(await applyHot(["core"], disk.ports)).toMatchObject({ ok: false, disk: "untouched", error: "could not install it on disk: read-only volume" });
    expect(disk.calls).toEqual(["stage core"]);
  });
});

describe("HotInstaller", () => {
  async function setup(incoming: Spec) {
    const { root, running, incoming: build } = await pair({}, incoming);
    const reports: HotReport[] = [];
    const swaps: string[] = [];
    let renderer = "/bundled/renderer";
    const installer = new HotInstaller({
      target: running, dataDir: join(root, "data"), fs, run,
      notify: (report) => reports.push(report),
      ports: {
        coreScript: () => "/bundled/core/main.cjs",
        swapCore: async (script) => { swaps.push(script); return { ok: true, script, entries: 0, interrupted: [], ms: 1 }; },
        useRenderer: (dir) => { const before = renderer; renderer = dir; return before; },
        reloadChat: async () => true, reloadShell: async () => true, log: () => {},
      },
    });
    const request = { path: build, requester: "DEV", note: "Faster", from: "2.0.0-dev.1", to: "2.0.0-dev.2" };
    return { root, running, build, installer, reports, swaps, request, renderer: () => renderer };
  }

  it("hot: installs the new bundle on disk, swaps to the core copied to <data>/hot-builds, serves the new pages, and reports", async () => {
    const { root, running, installer, reports, swaps, request, renderer } = await setup({ files: { "out/core/main.cjs": "core v2", "out/renderer/renderer.js": "shell v2" } });
    expect((await installer.plan(request.path)).plan).toEqual({ mode: "hot", parts: ["core", "shell"] });
    expect(await installer.install(request)).toMatchObject({ ok: true });
    await expect.poll(() => reports.length).toBe(1);
    expect(reports[0]).toEqual({ ok: true, applied: ["core", "shell"], disk: "installed", requester: "DEV", note: "Faster", from: "2.0.0-dev.1", to: "2.0.0-dev.2" });
    expect(swaps).toHaveLength(1);
    expect(swaps[0]!.startsWith(join(root, "data", "hot-builds"))).toBe(true);
    expect(readFileSync(swaps[0]!, "utf8")).toBe("core v2");
    expect(readFileSync(join(renderer(), "renderer.js"), "utf8")).toBe("shell v2");
    expect((await bundlePrints(running, fs)).parts.core).toBe((await bundlePrints(request.path, fs)).parts.core);
    expect(fs.readdirSync(join(root, "data", "core", "self-update", "backups")).filter((name) => name.endsWith(".hot.app"))).toHaveLength(1);
    // The same build again: the running one is now the new build, nothing differs.
    expect((await installer.plan(request.path)).plan).toEqual({ mode: "hot", parts: [] });
  });

  it("kernel changed: refuses to hot-install (the core restarts as before)", async () => {
    const { installer, reports, request } = await setup({ files: { "out/main/main.cjs": "main v2" } });
    expect(await installer.install(request)).toEqual({ ok: false, error: "It needs a restart: kernel changed: main process", plan: { mode: "restart", reasons: ["kernel changed: main process"] } });
    expect(reports).toHaveLength(0);
  });

  it("uncertain is a restart: the app on disk replaced behind the running process, the running app itself, no bundle", async () => {
    const { running, installer, request } = await setup({ files: { "out/core/main.cjs": "core v2" } });
    expect((await installer.plan(running)).plan).toMatchObject({ mode: "restart", reasons: [expect.stringMatching(/cannot be installed in place/)] });
    expect((await installer.plan(join(running, "..", "nothing.app"))).plan).toMatchObject({ mode: "restart", reasons: [expect.stringMatching(/there is no build/)] });
    // Someone copied another build over the running one.
    fs.rmSync(join(running, "Contents", "Resources", "app.asar"));
    fs.copyFileSync(join(request.path, "Contents", "Resources", "app.asar"), join(running, "Contents", "Resources", "app.asar"));
    expect((await installer.plan(request.path)).plan).toEqual({ mode: "restart", reasons: ["could not compare with the running build: the app on disk changed since Botling started"] });
    const unbundled = new HotInstaller({ target: null, dataDir: tempDir("hot-install"), fs, run, notify: () => {}, ports: {} as never });
    expect((await unbundled.plan(request.path)).plan).toEqual({ mode: "restart", reasons: ["this Botling is not running from an app bundle"] });
  });
});
