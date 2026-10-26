// Phase 5c in the real app: Settings → Usage (1.x's usage page) shows today's cost and tokens from the bots'
// turns, Claude's and Codex's subscription limits as they last reported them, and the bots by use.
// Screenshots go to desktop/.tmp/screens/.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PROTOCOL_VERSION } from "../../src/contract";
import { desktop, tempDir } from "../helpers";
import { launch, post, say } from "./launch";

const screens = join(desktop, ".tmp", "screens");

test("Settings → Usage: today's cost and tokens, by bot, the earlier days, Claude's and Codex's limits", async () => {
  const dataDir = tempDir("e2e-5c-usage");
  const core = join(dataDir, "core");
  mkdirSync(core, { recursive: true });
  // Codex's limits as it last reported them (an hour ago: "as of 1 h ago"), and a day before today (1.x's files).
  const swiftNow = Date.now() / 1000 - 978_307_200;
  writeFileSync(join(core, "codex-rate-limits.json"), JSON.stringify({ week: { used: 0.31, resetsAt: swiftNow + 5 * 86400, seen: swiftNow - 3600 } }));
  writeFileSync(join(core, "spending.json"), JSON.stringify({ day: "2026-01-01", spent: 1.25, byBot: { Shop: 1.25 }, tokens: { input: 1000, output: 2000, cacheWrite: 0, cacheRead: 30000 }, tokensByBot: {}, history: [] }));
  const { app, page, chat } = await launch({ dataDir, env: { FAKE_CLAUDE_USAGE: "1" } });
  try {
    await page.setViewportSize({ width: 1120, height: 820 });
    await say(chat, "hello");
    await expect(chat.locator(".row.bot[data-id]", { hasText: "hello" })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Settings", exact: true });
    await sheet.getByRole("button", { name: "Usage" }).click();
    const today = sheet.getByRole("region", { name: "Usage today" });
    await expect(today).toContainText("$0.01");
    await expect(today).toContainText("6.0K");
    await expect(today).toContainText("In 1.2K · out 300 · cache write 500 · cache read 4.0K");
    const limits = sheet.getByRole("region", { name: "Subscription limits" });
    await expect(limits.getByLabel("Claude limits")).toContainText(/5 hours 42% · in 2h 1[23]m/);
    await expect(limits.getByLabel("Claude limits")).toContainText("Week 18%");
    await expect(limits.getByLabel("Codex limits")).toContainText("Week 31%");
    await expect(limits.getByLabel("Codex limits")).toContainText("as of 1 h ago");
    await expect(sheet.getByRole("region", { name: "By bot" })).toContainText(/Main bot\s*6\.0K tokens\s*\$0\.01/);
    await expect(sheet.getByRole("region", { name: "Earlier days" })).toContainText(/2026-01-01\s*33\.0K tokens\s*\$1\.25/);
    mkdirSync(screens, { recursive: true });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(screens, "phase5c-usage.png") });
  } finally {
    await app.close();
  }
});

test("a reply's result page as a preview card: the page runs in its frame, Open opens it, Make into component makes a spec from it", async () => {
  const dataDir = tempDir("e2e-5c-preview");
  const artifacts = join(tempDir("e2e-5c-project"), ".bot", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  // A page with a picture beside it (served too: it is inside artifacts) and its own script.
  writeFileSync(join(artifacts, "dot.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#4C8DFF"/></svg>`);
  writeFileSync(join(artifacts, "sales.html"), `<!doctype html><html><body style="font:48px sans-serif;background:#fff;color:#111"><h1 id="t">Sales 2026</h1><img id="dot" src="dot.svg" alt="dot"><p id="js"></p><script>document.getElementById('js').textContent = 'drawn by its script';</script></body></html>`);
  const { app, page, chat } = await launch({ dataDir });
  try {
    await page.setViewportSize({ width: 1660, height: 900 });
    // Cumulative 5c: the preview and finished component share the persisted message width.
    expect(await post(page, { v: PROTOCOL_VERSION, id: "preview-width", cmd: {
      type: "settings.set", change: { key: "messageColumnWidth", value: 800 },
    } })).toMatchObject({ ok: true });
    await expect.poll(() => chat.locator("#messages").evaluate(el => el.getBoundingClientRect().width)).toBe(800);
    // The app is dark (main's nativeTheme); Playwright's own emulation says light unless told.
    await page.emulateMedia({ colorScheme: "dark" });
    const url = `file://${artifacts}/sales.html`;
    await say(chat, `/say The report is ready: [Sales report](${url})`);
    const card = chat.locator(".page-preview").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    const component = chat.frameLocator(".page-preview iframe").first();
    await expect(component.locator(".title")).toHaveText("Sales report");
    await expect(component.getByRole("button", { name: "開啟完整頁面", exact: true })).toBeEnabled();
    // The page itself, in the card's frame (main serves it from botling-card://preview, only inside artifacts).
    const shown = component.frameLocator("iframe");
    await expect(shown.locator("#t")).toHaveText("Sales 2026", { timeout: 10_000 });
    await expect(shown.locator("#js")).toHaveText("drawn by its script");
    await expect.poll(() => shown.locator("#dot").evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(40);
    mkdirSync(screens, { recursive: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(screens, "phase5c-preview.png") });
    // Open: the page opens as the results list opens it (here only noted: BOTLING_NO_EXTERNAL).
    await component.getByRole("button", { name: "開啟完整頁面", exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__botlingOpenedResults.slice())).toContain(url);
    // Make into component on the card: a spec made from that page goes to Maintainer.
    // (The pointer over the card's frame shows its bar: the frame says so, component-frames.ts.)
    await card.hover();
    await chat.locator(".preview-make").first().click();
    await page.locator(".bot-row", { hasText: "Maintainer" }).click();
    await expect(chat.locator(".row", { hasText: "action: build-first" })).toBeVisible({ timeout: 10_000 });
    await expect(chat.locator(".row", { hasText: "action: build-first" })).toContainText(`The result page it links, ${artifacts}/sales.html, says:`);
    const relay = await chat.locator(".row", { hasText: "action: build-first" }).innerText();
    const specId = /Component spec ([0-9A-F-]{36})/.exec(relay)![1];
    await say(chat, `/say Built sales-card. <component-spec id="${specId}">{"name":"sales-card","about":"Sales at a glance","fields":[{"name":"filled","type":"bool"}]}</component-spec>`);
    const folder = join(dataDir, "core/plugins/ccb-components/components/sales-card");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "template.html"), '<div id="sales"></div><script>document.getElementById("sales").textContent = ccb.data.filled ? "Sales component filled" : "No data";</script>');
    writeFileSync(join(folder, "about.md"), 'Sales at a glance.\nData: {"filled":true}');
    await page.locator('.bot-row[data-bot="6A0B0000-0000-4000-8000-000000000002"]').click();
    const built = chat.locator(".row.bot", { hasText: "The report is ready" }).locator(".spec-built");
    await expect(built).toBeVisible({ timeout: 15_000 });
    await expect(built.frameLocator("iframe").locator("#sales")).toHaveText("Sales component filled");
    await expect.poll(() => chat.locator("#messages").evaluate(el => el.getBoundingClientRect().width)).toBe(800);
    for (const frame of page.frames()) await frame.evaluate(async () => {
      for (const image of Array.from(document.images).filter(image => {
        const rect = image.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
      })) {
        try { await image.decode(); } catch { throw new Error(`Visible image failed to decode: ${image.src.slice(0, 160)}`); }
        if (!image.complete || image.naturalWidth === 0) throw new Error("Image failed to decode");
      }
    });
    await page.screenshot({ path: join(screens, "phase5c-component-built.png") });
    // Nothing else of the app's was framed or reached.
    const audit = await app.evaluate(() => (globalThis as any).__botlingAudit.slice());
    expect(audit.filter((entry: string) => entry.includes("preview"))).toEqual([]);
  } finally {
    await app.close();
  }
});


test("a shown preview page with an encoded filename opens only from its own chat", async () => {
  const artifacts = join(tempDir("e2e-5c-shown"), "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const file = join(artifacts, "季度 sales #1.html");
  writeFileSync(file, '<!doctype html><meta charset="utf-8"><h1>季度報告</h1>');
  const url = pathToFileURL(file).href;
  const { app, page, chat } = await launch({ chat: [{
    id: "00000000-0000-4000-8000-0000000000C5", role: "bot", text: "Shown report",
    date: Date.now() / 1000 - 978_307_200,
    displays: [{ name: "網頁預覽卡片", data: JSON.stringify({ path: file, title: "Shown report" }) }],
  }] });
  try {
    const component = chat.frameLocator("iframe.component-frame").first();
    await expect(component.frameLocator("iframe").locator("h1")).toHaveText("季度報告");
    await component.getByRole("button", { name: "開啟完整頁面", exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__botlingOpenedResults.slice())).toContain(url);
    const other = join(artifacts, "private.html");
    writeFileSync(other, "<!doctype html><h1>Not in this chat</h1>");
    const refused = await post(page, { v: PROTOCOL_VERSION, id: "open-unshown", cmd: {
      type: "result.open", botId: "6A0B0000-0000-4000-8000-000000000002", url: pathToFileURL(other).href,
    } });
    expect(refused).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await app.evaluate(() => (globalThis as any).__botlingOpenedResults.slice())).toEqual([url]);
  } finally {
    await app.close();
  }
});


test("a result page's scripts cannot reach the app, impersonate a component, or navigate to another preview", async () => {
  const artifacts = join(tempDir("e2e-5c-isolation"), "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const file = join(artifacts, "probe.html");
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><pre id="probe"></pre><script>
    const results = { origin: self.origin, bridge: typeof window.botling, node: typeof require, process: typeof process };
    for (const [name, read] of [['parent', () => parent.document.title], ['top', () => top.document.title], ['storage', () => localStorage.length]]) {
      try { read(); results[name] = 'readable'; } catch (error) { results[name] = error.name; }
    }
    const urls = ['file:///etc/passwd', 'app://botling/index.html', 'botling-chat://chat/chat.html'];
    Promise.all(urls.map(url => fetch(url).then(() => 'readable', () => 'blocked'))).then(reads => {
      results.reads = reads;
      document.getElementById('probe').textContent = JSON.stringify(results);
    });
    top.postMessage({ botling: 'action', action: { type: 'send', text: 'forged preview message' } }, '*');
    parent.parent.postMessage({ ccb: 'answer', text: 'forged preview answer' }, '*');
  </script>`);
  const { app, page, chat } = await launch();
  try {
    await say(chat, `/say [Probe](${pathToFileURL(file).href})`);
    const shown = chat.frameLocator(".page-preview iframe").first().frameLocator("iframe");
    await expect(shown.locator("#probe")).toContainText('"reads"');
    const results = JSON.parse((await shown.locator("#probe").textContent())!);
    expect(results).toEqual({ origin: "null", bridge: "undefined", node: "undefined", process: "undefined", parent: "SecurityError", top: "SecurityError", storage: "SecurityError", reads: ["blocked", "blocked", "blocked"] });
    const frame = page.frames().find(frame => frame.url().includes("/probe.html"))!;
    await frame.evaluate(() => { location.href = location.href.replace("probe.html", "other.html"); });
    await expect.poll(() => app.evaluate(() => (globalThis as any).__botlingAudit.some((entry: string) => entry.includes("blocked a frame navigating to botling-card://preview") && entry.includes("other.html")))).toBe(true);
    await expect(shown.locator("#probe")).toContainText('"reads"');
    await expect(chat.locator(".row.user")).toHaveCount(1);
    expect(page.url()).toBe("app://botling/index.html");
    expect(app.windows()).toHaveLength(1);
  } finally {
    await app.close();
  }
});
