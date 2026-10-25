// Phase 3b in the real app: the Plugins panel (a plugin on and off, a setting, a secret sealed by
// Electron safeStorage — the mock keychain in tests — and never shown back, a command run in the
// plugin host), a plugin panel in its sandboxed frame calling its own program part, Maintainer in the
// left column taking a bot's <component> request, and <install> asking first. Screenshots go to
// desktop/.tmp/screens/.
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir, until } from "../helpers";
import { launch, say } from "./launch";

const screens = join(desktop, ".tmp", "screens");
const shot = async (page: import("@playwright/test").Page, name: string) => {
  mkdirSync(screens, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};

/** A plugin with a web part that draws a panel, and a program part that answers it. */
function writePlugin(core: string) {
  const folder = join(core, "plugins", "panelpal");
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({
    name: "panelpal", displayName: "Panel pal", version: "1.0.0", description: "A panel that asks its program part.", engines: { ccb: "^2.0.0" },
    ccb: {
      web: "dist/web.js", host: "dist/host.mjs",
      contributes: {
        panels: [{ id: "main", title: "Pal" }],
        commands: [{ id: "panelpal.count", title: "Count" }],
        settings: { loud: { type: "boolean", default: false, title: "Loud" }, token: { type: "string", title: "API token", secret: true } },
      },
    },
  }));
  writeFileSync(join(folder, "dist", "host.mjs"), `export function activate(ccb) {
    ccb.commands.register("panelpal.count", () => 42);
    ccb.web.handle("echo", (params) => ({ echo: params, loud: ccb.settings.get("loud"), hasToken: !!ccb.settings.get("token") }));
  }`);
  writeFileSync(join(folder, "dist", "web.js"), `export function activate(ccb) {
    ccb.panels.register("main", (root) => {
      const button = document.createElement("button");
      button.textContent = "Ask the program part";
      const out = document.createElement("pre");
      out.id = "out";
      button.onclick = async () => { out.textContent = JSON.stringify(await ccb.host.call("echo", { n: 1 })); };
      // What a panel frame can reach: nothing of the app's.
      const probe = {};
      try { probe.parent = !!parent.document; } catch { probe.parent = "blocked"; }
      try { probe.storage = !!localStorage; } catch { probe.storage = "blocked"; }
      probe.origin = self.origin; // the effective (sandboxed, opaque) origin
      probe.bridge = typeof window.botling;
      const facts = document.createElement("pre");
      facts.id = "probe";
      facts.textContent = JSON.stringify(probe);
      root.append(button, out, facts);
      fetch("https://example.com/").then(() => { facts.dataset.fetch = "reached"; }, () => { facts.dataset.fetch = "blocked"; });
    });
  }`);
}

test("the Plugins panel: on/off, a setting, a sealed secret, a command; a panel in its sandboxed frame", async () => {
  const dataDir = tempDir("e2e-plugins");
  const core = join(dataDir, "core");
  writePlugin(core);
  const { app, page } = await launch({ dataDir, env: { BOTLING_MOCK_KEYCHAIN: "1", BOTLING_COMPONENT_SCAN_MS: "200" } });
  try {
    await page.setViewportSize({ width: 1120, height: 820 });
    // Maintainer is in the left column, right under the main bot (1.x's MaintainerRow).
    await expect(page.locator(".bot-row").nth(1)).toContainText("Maintainer");
    await page.getByRole("button", { name: "Plugins" }).click();
    const panel = page.getByRole("dialog", { name: "Plugins" });
    const item = panel.locator('.plugin[data-plugin="panelpal"]');
    await expect(item).toContainText("Panel pal");
    await expect(item.getByRole("button", { name: "Count" })).toBeEnabled({ timeout: 15_000 });
    await item.getByRole("button", { name: "Count" }).click();
    await expect(panel.locator(".plugins-result")).toHaveText("Count: 42");
    // The program part runs in a utility process main started (no Node of its own needed).
    const hosts = await app.evaluate(() => (globalThis as any).__botlingHostPids());
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toBeGreaterThan(0);
    // A secret: sent once, sealed, never shown back.
    await item.getByLabel("API token").fill("tok-very-secret");
    await item.locator('[data-setting="token"]').getByRole("button", { name: "Save" }).click();
    await expect(item.getByLabel("API token")).toHaveAttribute("placeholder", "Set (hidden)");
    const sealed = await until(() => (existsSync(join(core, "plugin-secrets.json")) ? readFileSync(join(core, "plugin-secrets.json"), "utf8") : null));
    expect(sealed).not.toContain("tok-very-secret");
    expect(Object.keys(JSON.parse(sealed).panelpal)).toEqual(["token"]);
    expect(await page.evaluate(() => document.body.innerHTML.includes("tok-very-secret"))).toBe(false);
    // (The boxes show what the core saved: they change once it says so.)
    await item.getByLabel("Loud").click();
    await expect(item.getByLabel("Loud")).toBeChecked();
    await expect.poll(() => JSON.parse(readFileSync(join(core, "plugins.json"), "utf8")).settings.panelpal.loud).toBe(true);
    await shot(page, "plugins-panel");
    // Its panel, in a sandboxed frame: it reaches its own program part, and nothing of the app's.
    await item.getByRole("button", { name: "Open Pal" }).click();
    const pal = page.getByRole("dialog", { name: "Pal" });
    const frame = page.frameLocator(".plugin-panel-frame");
    await expect(pal.locator(".plugin-panel-frame")).toHaveAttribute("sandbox", "allow-scripts");
    await frame.getByRole("button", { name: "Ask the program part" }).click();
    await expect(frame.locator("#out")).toHaveText(JSON.stringify({ echo: { n: 1 }, loud: true, hasToken: true }), { timeout: 10_000 });
    const probe = JSON.parse(await frame.locator("#probe").textContent() ?? "{}");
    expect(probe).toEqual({ parent: "blocked", storage: "blocked", origin: "null", bridge: "undefined" });
    await expect(frame.locator("#probe")).toHaveAttribute("data-fetch", "blocked");
    await shot(page, "plugin-panel-frame");
    await pal.getByRole("button", { name: "Close" }).click();
    // Off: its program part stops; on again: back.
    await page.getByRole("button", { name: "Plugins" }).click();
    await item.getByLabel("Panel pal on").click();
    await expect(item).toHaveAttribute("data-enabled", "0");
    await expect(item.getByRole("button", { name: "Count" })).toBeDisabled();
    // With no program part to run, the host's utility process is gone.
    await expect.poll(() => app.evaluate(() => (globalThis as any).__botlingHostPids().length)).toBe(0);
    expect(JSON.parse(readFileSync(join(core, "plugins.json"), "utf8")).disabled).toEqual(["panelpal"]);
  } finally {
    await app.close();
  }
});

test("Maintainer takes a bot's <component> request; <install> asks in the main bot's chat first", async () => {
  const dataDir = tempDir("e2e-maintainer");
  const source = join(tempDir("e2e-outside"), "counter");
  mkdirSync(join(source, "dist"), { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "counter", displayName: "Word counter", version: "0.3.0", description: "Counts words.", license: "MIT", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", permissions: ["composer"] } }));
  writeFileSync(join(source, "dist", "host.mjs"), "export function activate() {}\n");
  const { app, page, chat } = await launch({ dataDir, env: { BOTLING_MOCK_KEYCHAIN: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  try {
    await page.setViewportSize({ width: 1120, height: 820 });
    await say(chat, `/say I'll ask Maintainer. <component name="weather">a weather card for today</component>`);
    await expect(chat.locator(".row.bot[data-id]", { hasText: "I'll ask Maintainer." })).toBeVisible({ timeout: 10_000 });
    await expect(chat.locator(".row", { hasText: "cannot do this yet" })).toHaveCount(0);
    // (Its turn ends before the next message: a message during a reply would join it, as 1.x merges.)
    await expect(page.locator(".chat-status")).not.toHaveText("Writing…", { timeout: 10_000 });
    await say(chat, `/say Let me check it first. <install>${source}</install>`);
    const ask = chat.locator(".row", { hasText: 'Install the plugin "Word counter" 0.3.0?' });
    await expect(ask).toBeVisible({ timeout: 10_000 });
    await shot(page, "install-ask");
    expect(existsSync(join(dataDir, "core", "plugins", "counter"))).toBe(false);
    await ask.getByRole("button", { name: "Install", exact: true }).click();
    await expect(chat.locator(".row", { hasText: "Installed: Word counter 0.3.0." })).toBeVisible({ timeout: 10_000 });
    expect(existsSync(join(dataDir, "core", "plugins", "counter", "dist", "host.mjs"))).toBe(true);
    // Maintainer's chat: the request, handed over with who asked.
    await page.locator(".bot-row", { hasText: "Maintainer" }).click();
    await expect(chat.locator(".row", { hasText: 'Main bot wants a new component "weather": a weather card for today' })).toBeVisible({ timeout: 10_000 });
    await expect(chat.locator(".row.bot[data-id]", { hasText: "On it." })).toBeVisible({ timeout: 10_000 });
    await shot(page, "maintainer-request");
  } finally {
    await app.close();
  }
});
