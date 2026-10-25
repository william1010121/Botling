// Phase 5b: the packaged build itself (`npm run dist:mac`, then `npm run test:packaged`). Its fuses are
// off, so Playwright's Electron launcher (which needs --inspect) cannot drive it: the app is started
// as a user would start it, with Chromium's --remote-debugging-port, and the app page is reached over
// CDP. It runs on a throwaway data folder and HOME in desktop/.tmp, with stand-ins for claude and codex
// that only log being called, Chromium's mock keychain, and no 1.x import — never the user's data.
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { listPackage } from "@electron/asar";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { desktop, tempDir, until } from "../helpers";

const appBundle = process.env.BOTLING_PACKAGED_APP ?? join(desktop, "dist", "mac-arm64", "Botling 2.app");
const binary = join(appBundle, "Contents", "MacOS", "Botling 2");
const MAIN = "6A0B0000-0000-4000-8000-000000000002";

test.skip(process.platform !== "darwin", "The packaged smoke test runs on macOS only so far.");

test.beforeAll(() => {
  if (!existsSync(binary)) throw new Error(`No packaged app at ${appBundle}: run \`npm run dist:mac\` first (or set BOTLING_PACKAGED_APP).`);
});

test("the build: fuses hardened, ad-hoc signed and intact, only out/ in its asar", async () => {
  const wire = await getCurrentFuseWire(binary);
  expect(wire[FuseV1Options.RunAsNode]).toBe(48); // "0": off
  expect(wire[FuseV1Options.EnableCookieEncryption]).toBe(49);
  expect(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(48);
  expect(wire[FuseV1Options.EnableNodeCliInspectArguments]).toBe(48);
  expect(wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(49);
  expect(wire[FuseV1Options.OnlyLoadAppFromAsar]).toBe(49);
  expect(wire[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(48);
  // codesign: valid (ad-hoc unless a Developer ID was given), every helper and framework included.
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", appBundle], { encoding: "utf8" });
  expect(verify.status, verify.stderr).toBe(0);
  const plist = readFileSync(join(appBundle, "Contents", "Info.plist"), "utf8");
  expect(plist).toContain("<key>ElectronAsarIntegrity</key>");
  expect(plist).toContain("<string>io.github.william1010121.Botling2</string>");
  // What the asar holds: the bundles, nothing of node_modules, the sources, source maps or the test fixtures.
  const files = listPackage(join(appBundle, "Contents", "Resources", "app.asar"), { isPack: false });
  expect(files).toContain("/out/main/main.cjs");
  expect(files).toContain("/out/core/main.cjs");
  expect(files).toContain("/out/host/host-utility.mjs");
  expect(files).toContain("/out/renderer/index.html");
  expect(files.filter((file) => /node_modules|\/src\/|\/test\/|\.map$|fake-claude/.test(file))).toEqual([]);
});

test("--check-plugin runs in the packaged app (no Electron as Node)", () => {
  const base = tempDir("pkg-check");
  const plugin = join(base, "ccb-good");
  mkdirSync(join(plugin, "dist"), { recursive: true });
  writeFileSync(join(plugin, "dist", "web.js"), "export function activate() {}\n");
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "ccb-good", version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { permissions: [], web: "dist/web.js" } }));
  const run = spawnSync(binary, ["--check-plugin", plugin], { encoding: "utf8", env: isolated(base), timeout: 60_000 });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toBe(`✓ ${plugin} passes the checks.\n`);
  // RunAsNode is off: the app does not turn into Node for whoever sets the variable.
  const asNode = spawnSync(binary, ["-e", "process.stdout.write('node!')", "--check-plugin", plugin], { encoding: "utf8", env: { ...isolated(base), ELECTRON_RUN_AS_NODE: "1" }, timeout: 60_000 });
  expect(asNode.stdout).not.toContain("node!");
});

test("boots to the chat page, starts the plugin host as a utility process, ignores test-only variables and quits cleanly", async () => {
  const base = tempDir("pkg-smoke");
  const dataDir = join(base, "data");
  // Explicitly opt out so this smoke test never contacts real GitHub (production defaults on).
  mkdirSync(join(dataDir, "core"), { recursive: true });
  writeFileSync(join(dataDir, "core", "settings.json"), JSON.stringify({ updateCheckEnabled: false }));
  // A plugin with a program part, so the plugin host has something to run.
  const plugin = join(dataDir, "core", "plugins", "smoke");
  mkdirSync(join(plugin, "dist"), { recursive: true });
  writeFileSync(join(plugin, "package.json"), JSON.stringify({
    name: "smoke", displayName: "Smoke", version: "1.0.0", description: "Answers a command.", engines: { ccb: "^2.0.0" },
    ccb: { host: "dist/host.mjs", contributes: { commands: [{ id: "smoke.ping", title: "Ping" }] } },
  }));
  writeFileSync(join(plugin, "dist", "host.mjs"), `export function activate(ccb) { ccb.commands.register("smoke.ping", () => "pong from " + process.versions.electron); }\n`);
  const env = {
    ...isolated(base), BOTLING_HIDDEN:"1",
    BOTLING_DATA_DIR: dataDir,
    // Test-only steering a packaged build must ignore (src/main/packaged.ts).
    BOTLING_AGENT: "fake", BOTLING_TEST_WEB_SITES: JSON.stringify([{ id: "x", name: "X", url: "http://127.0.0.1:9/" }]),
    BOTLING_SHOT_COMMAND: "touch " + join(base, "pwned"), BOTLING_PLUGIN_HOST: "node", BOTLING_TEST_UPDATE_FEED: join(base, "no-feed.json"),
  };
  const app = spawn(binary, ["--use-mock-keychain", "--remote-debugging-port=0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  app.stdout!.on("data", (chunk) => { output += chunk; });
  app.stderr!.on("data", (chunk) => { output += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => app.once("exit", (code, signal) => resolve({ code, signal })));
  let browser: Browser | null = null;
  try {
    const endpoint = await until(() => /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1], { timeout: 30_000, what: "the DevTools endpoint" });
    browser = await chromium.connectOverCDP(endpoint);
    const page = await until(() => browser!.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url() === "app://botling/index.html"), { timeout: 30_000, what: "the app page" });
    await page.waitForSelector('.shell[data-ready="1"]', { timeout: 30_000 });
    const chat = page.frameLocator("#chat-frame");
    await chat.locator(".composer").waitFor({ timeout: 30_000 });
    await chat.locator(`html[data-chat="${MAIN}"]`).waitFor({ state: "attached", timeout: 30_000 });
    await expect(chat.getByRole("textbox", { name: "Message" })).toBeVisible();
    // The plugin host runs (a utility process main started) and answers the plugin's command.
    await expect.poll(async () => (await post(page, { type: "plugins.list" }))?.result?.host?.running, { timeout: 30_000 }).toBe(true);
    const answer = await until(async () => {
      const response = await post(page, { type: "plugins.command", id: "smoke.ping" });
      return response?.ok ? response : null;
    }, { timeout: 30_000, what: "the plugin's command" });
    expect(answer.result.result).toMatch(/^pong from \d+\.\d+\.\d+$/);
    expect(output).toMatch(/\[core\] plugin host started pid \d+ \(utility process\)/);
    // Test-only variables were dropped; the heads are the real CLIs (here: the stand-ins, never run).
    expect(output).toContain("[packaged] ignored BOTLING_AGENT, BOTLING_PLUGIN_HOST, BOTLING_SHOT_COMMAND, BOTLING_TEST_UPDATE_FEED, BOTLING_TEST_WEB_SITES");
    expect(output).toMatch(/\[core\] started epoch \S+ data .+ agent claude/);
    // The web AIs are the real three, not the test page BOTLING_TEST_WEB_SITES named.
    await expect(page.locator(".web-site-row .web-site-name")).toHaveText(["Gemini", "ChatGPT", "Claude"]);
    expect(existsSync(join(base, "agent-calls.log"))).toBe(false);
    // The explicitly saved opt-out is preserved: nothing was looked up.
    const updates = await post(page, { type: "updates.check", manual: false });
    expect(updates.result).toMatchObject({ current: expect.stringMatching(/^2\./), enabled: false, newer: null, checkedAt: null,
      installError: expect.stringContaining("Update trust is not configured"), readyVersion: null });
    const restart = await post(page, { type: "updates.restart" });
    expect(restart).toMatchObject({ ok: false, error: { message: expect.stringContaining("Download and verify") } });
    expect(existsSync(join(dataDir, "update-pending.json"))).toBe(false);
    expect(existsSync(join(dataDir, "updates.json"))).toBe(false);
    // Nothing went to the default places: no 1.x import, no Application Support folder in HOME.
    expect(existsSync(join(dataDir, "core", "import.json")) ? JSON.parse(readFileSync(join(dataDir, "core", "import.json"), "utf8")) : null).toBeNull();
    expect(existsSync(join(base, "home", "Library", "Application Support", "Botling 2"))).toBe(false);
    // Cards render content (Phase 5c). The welcome line's card is a sandboxed botling-card:// frame that
    // loads a moment after the chat page; Phase 5b's screenshot was taken before it had, so it showed an
    // empty box. Its page is drawn, it has sized itself (a frame still at its first 80px never loaded),
    // and ccb.save goes through the broker to the core and back into the card.
    const counter = chat.frameLocator('[data-card="c-counter"] iframe');
    await expect(counter.getByRole("button", { name: "Count: 0" })).toBeVisible({ timeout: 30_000 });
    await expect(counter.getByRole("button", { name: "Say hello" })).toBeVisible();
    await expect(counter.getByText("This card runs in a sandboxed frame.")).toBeVisible();
    await expect.poll(() => chat.locator('[data-card="c-counter"] iframe').evaluate((frame) => (frame as HTMLIFrameElement).style.height), { timeout: 10_000 }).not.toBe("80px");
    await counter.getByRole("button", { name: "Count: 0" }).click();
    await expect(counter.getByRole("button", { name: "Count: 1" })).toBeVisible();
    await expect.poll(() => {
      const saved = JSON.parse(readFileSync(join(dataDir, "core", "main", "chat.json"), "utf8")) as { cards?: { id: string; data: string | null }[] }[];
      return saved.flatMap((message) => message.cards ?? []).find((card) => card.id === "c-counter")?.data ?? null;
    }, { timeout: 10_000 }).toBe('{"count":1}');
    mkdirSync(join(desktop, ".cache", "evidence", "review-d"), { recursive: true });
    await page.screenshot({ path: join(desktop, ".cache", "evidence", "review-d", "packaged-smoke.png") });
    await browser.close().catch(() => {});
    browser = null;
    // Quit as the system asks an app to (SIGTERM → before-quit): the core and the host end with it.
    app.kill("SIGTERM");
    const end = await Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000))]);
    expect(end, "the app quit within 30 s").not.toBeNull();
    expect(end!.code).toBe(0);
    await expect.poll(() => running(appBundle), { timeout: 10_000 }).toEqual([]);
    expect(existsSync(join(base, "pwned"))).toBe(false);
  } finally {
    await browser?.close().catch(() => {});
    if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL");
    for (const pid of running(appBundle)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
});

/** A clean environment: a HOME of its own, stand-ins for the CLIs, no 1.x folder. */
function isolated(base: string): NodeJS.ProcessEnv {
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(base, "home"), { recursive: true });
  const stub = join(bin, "agent-stub");
  writeFileSync(stub, `#!/bin/sh\necho "$0 $*" >> '${join(base, "agent-calls.log")}'\nexit 1\n`);
  chmodSync(stub, 0o755);
  return {
    BOTLING_HIDDEN:"1", PATH: `${bin}:/usr/bin:/bin`, HOME: join(base, "home"), TMPDIR: base, LANG: "en_US.UTF-8",
    BOTLING_IMPORT_FROM: "", BOTLING_1X_DIR: "", BOTLING_CLAUDE_PATH: stub, BOTLING_CODEX_PATH: stub, BOTLING_LANGUAGES: "en-US",
  };
}

/** Posts a command through the app page's bridge (as the page itself does) and returns the response. */
function post(page: Page, cmd: Record<string, unknown>): Promise<any> {
  const id = `smoke-${Math.random().toString(36).slice(2)}`;
  return page.evaluate(({ id, cmd }) => new Promise((resolve) => {
    const bridge = (window as any).botling;
    const off = bridge.subscribe((message: any) => { if (message && message.id === id) { off(); resolve(message); } });
    bridge.post({ v: 10, id, cmd });
    setTimeout(() => { off(); resolve(null); }, 5_000);
  }), { id, cmd });
}

/** Pids of processes running from the app bundle. */
function running(bundle: string): number[] {
  const list = spawnSync("pgrep", ["-f", bundle], { encoding: "utf8" });
  return list.stdout.split("\n").map(Number).filter((pid) => pid > 0);
}
