// Phase 4a item 5 in the real app: a web AI (here a local page standing in for Gemini, ChatGPT or
// Claude: no real site is ever opened) in the app's own browser. The page sits in its own session,
// with no Node, no preload and no Botling bridge; a question is a row in the left column at once,
// its answer is read by the plugin's page reader and saved for the main bot; links to other sites go
// outside (only noted in tests); "Ask Main bot about this" names the saved file; the list lasts.
// Screenshots go to desktop/.tmp/screens/.
import { expect, test, type ElectronApplication } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir, until } from "../helpers";
import { audit, launch, MAIN } from "./launch";

let server: Server;
let origin: string;
/** Conversations the fake site keeps, by id. */
const kept = new Map<string, { title: string; turns: { role: string; text: string }[] }>();

function sitePage(id: string | null, outside: string) {
  const stored = (id && kept.get(id)) || { title: "", turns: [] };
  return `<!doctype html><html><head><meta charset="utf-8"><title>${stored.title ? `${stored.title} - TestAI` : "TestAI"}</title>
<style>body { font: 14px sans-serif; background: #fff; color: #111; } .turn { margin: 6px; padding: 6px; border-radius: 6px; } .user { background: #def; } .assistant { background: #efe; }</style></head>
<body><h1>TestAI</h1><div id="turns"></div><textarea id="q"></textarea><button id="send">Send</button>
<a id="outside" href="${outside}/elsewhere">Elsewhere</a> <a id="inside" href="/app">New chat</a>
<script>
const turns = document.getElementById("turns");
const add = (role, text) => { const d = document.createElement("div"); d.className = "turn " + role; d.textContent = text; turns.append(d); };
for (const t of ${JSON.stringify(stored.turns)}) add(t.role, t.text);
document.cookie = "seen=1; Max-Age=3600; Path=/";
window.probe = () => ({ bridge: typeof window.botling, require: typeof require, process: typeof process, reader: typeof window.__ccbWeb, ipc: typeof window.ipcRenderer });
document.getElementById("send").onclick = () => {
  const q = document.getElementById("q").value;
  add("user", q);
  setTimeout(() => {
    const id = "conv" + Math.random().toString(36).slice(2, 10);
    history.pushState({}, "", "/app/" + id);
    setTimeout(() => {
      add("assistant", "Answer to: " + q);
      document.title = q + " - TestAI";
      fetch("/save/" + id, { method: "POST", body: JSON.stringify({ title: q, turns: [{ role: "user", text: q }, { role: "assistant", text: "Answer to: " + q }] }) });
    }, 1200);
  }, 300);
};
</script></body></html>`;
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    const outside = `http://localhost:${(server.address() as AddressInfo).port}`;
    const saved = /^\/save\/([a-z0-9]+)$/.exec(url.pathname);
    if (saved && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => { kept.set(saved[1]!, JSON.parse(body)); response.end("ok"); });
      return;
    }
    const page = /^\/app(?:\/([a-z0-9]+))?\/?$/.exec(url.pathname);
    if (page) {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(sitePage(page[1] ?? null, outside));
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>${url.pathname}</title><p>${url.pathname}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** The local site as the app's only web AI, and its page reader in the plugin library. */
function prepare(dataDir: string) {
  const readers = join(dataDir, "core", "plugins", "ccb-web-extractors");
  mkdirSync(readers, { recursive: true });
  writeFileSync(join(readers, "testai.js"), `function extract(doc) {
  const turns = [...doc.querySelectorAll(".turn")].map((el) => ({ role: el.classList.contains("user") ? "user" : "assistant", text: el.textContent }));
  return { title: null, turns };
}`);
  return { BOTLING_TEST_WEB_SITES: JSON.stringify([{ id: "testai", name: "TestAI", startURL: `${origin}/app`, conversationMarker: "app", insideDomains: ["127.0.0.1"], accent: "#4C7DF0" }]) };
}

/** Runs code in the site's front page, in the page's own world (as its scripts would). */
function inPage<T>(app: ElectronApplication, code: string): Promise<T> {
  return app.evaluate(async (_electron, code) => {
    const contents = (globalThis as any).__botlingWeb.frontContents("testai");
    if (!contents) throw new Error("no page");
    return contents.executeJavaScript(code, true);
  }, code) as Promise<T>;
}
const pageURL = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__botlingWeb.frontContents("testai")?.getURL() ?? null) as Promise<string | null>;
const shown = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows()[0]!;
  return window.contentView.children.map((view) => view.getBounds());
});

const screens = join(desktop, ".tmp", "screens");

test("a web AI in its own session: a question is a row at once, its answer is saved for the main bot, links go outside", async () => {
  const dataDir = tempDir("e2e-web");
  const env = prepare(dataDir);
  const { app, page, chat } = await launch({ dataDir, env });
  try {
    await page.setViewportSize({ width: 1180, height: 820 });
    // The left column's Web section: the site, no conversations yet.
    const siteRow = page.locator('.web-site-row[data-site="testai"]');
    await expect(siteRow).toHaveAttribute("aria-label", "TestAI, web, 0 conversations");
    await siteRow.click();
    await expect(page.locator(".chat-title:visible")).toHaveText("TestAI");
    await until(async () => (await pageURL(app)) === `${origin}/app`, { what: "the site's start page" });
    // The page is in the window, over the box the app page keeps for it.
    const box = await page.locator(".web-page").boundingBox();
    const views = await until(async () => { const list = await shown(app); return list.length ? list : null; }, { what: "the site's view in the window" });
    expect(views).toHaveLength(1);
    expect(Math.abs(views[0]!.x - box!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(views[0]!.width - box!.width)).toBeLessThanOrEqual(1);
    await expect(page.locator(".web-strip .web-status")).toHaveText("A new question is saved once it has an answer");

    // Locked down: its own session, sandboxed, no preload, no Node, and nothing of Botling's (nor the reader's world) in reach.
    const preferences = await app.evaluate(({ session }) => {
      const contents = (globalThis as any).__botlingWeb.frontContents("testai");
      const prefs = contents.getLastWebPreferences();
      return { sandbox: prefs.sandbox, node: prefs.nodeIntegration, isolation: prefs.contextIsolation, preload: prefs.preload ?? null, ownSession: contents.session === session.fromPartition("persist:web-testai"), notDefault: contents.session !== session.defaultSession };
    });
    expect(preferences).toEqual({ sandbox: true, node: false, isolation: true, preload: null, ownSession: true, notDefault: true });
    await until(() => inPage<any>(app, "document.cookie"), { what: "the site's cookie" });
    expect(await inPage(app, "window.probe()")).toEqual({ bridge: "undefined", require: "undefined", process: "undefined", reader: "undefined", ipc: "undefined" });
    const cookies = await app.evaluate(async ({ session }) => ({
      site: (await session.fromPartition("persist:web-testai").cookies.get({})).map((cookie) => cookie.name),
      app: (await session.defaultSession.cookies.get({})).length,
    }));
    expect(cookies).toEqual({ site: ["seen"], app: 0 });

    // A question: a row at once (waiting), then the answer is read and saved.
    await inPage(app, `document.getElementById("q").value = "How do I sort a list"; document.getElementById("send").click(); true`);
    const row = page.locator(".web-row").first();
    await expect(row).toHaveClass(/awaiting/);
    await expect(row).toContainText("How do I sort a list");
    await expect(page.locator(".web-strip .web-status")).toContainText("Waiting for TestAI's answer");
    await expect(page.locator(".web-strip .web-status")).toHaveText("Saved for Main bot · 2 messages", { timeout: 15_000 });
    await expect(row).not.toHaveClass(/awaiting/);
    const folder = join(dataDir, "core", "web", "testai");
    const files = readdirSync(folder).filter((name) => name.endsWith(".md"));
    expect(files).toEqual(["how-do-i-sort-a-list.md"]);
    const text = readFileSync(join(folder, files[0]!), "utf8");
    expect(text).toMatch(/^# How do I sort a list\n\n- Site: TestAI\n- URL: http:\/\/127\.0\.0\.1:\d+\/app\/conv[a-z0-9]+\n- Saved: .+\n- Messages: 2\n\n## You\n\nHow do I sort a list\n\n## TestAI\n\nAnswer to: How do I sort a list\n$/);
    await expect(siteRow).toHaveAttribute("aria-label", "TestAI, web, 1 conversation");
    await expect(page.locator(".detail-panel .web-question-title")).toHaveText("How do I sort a list");
    await expect(page.locator(".detail-panel .web-question-file")).toHaveText(join(folder, files[0]!));
    // The app page around the site (the site's own view is main's, not in a page screenshot).
    mkdirSync(screens, { recursive: true });
    await page.screenshot({ path: join(screens, "web-ai.png") });

    // A link to another site and a pop-up to one open outside the app (noted only, in tests); the page stays.
    const before = await pageURL(app);
    await inPage(app, `document.getElementById("outside").click(); window.open("http://localhost:1/pop"); true`);
    await until(async () => (await audit(app)).filter((entry) => entry.startsWith("opened outside the app from TestAI")).length >= 2, { what: "both opened outside" });
    expect(await pageURL(app)).toBe(before);

    // Ask Main bot about this: the main bot's chat, with a message naming the saved file.
    await page.locator(".web-ask").click();
    await expect(page.locator(".chat-title:visible")).toHaveText("Main bot");
    expect(await shown(app)).toEqual([]);
    await expect(chat.locator(".row.user").last()).toContainText(`About my TestAI conversation "How do I sort a list": read ${join(folder, files[0]!)} and tell me what matters in it.`);
    await expect(chat.locator(".row.bot[data-id]").last()).toHaveAttribute("data-state", "done");
    // A bot's chat again: the site's page is out of the window (it keeps running behind).
    expect(await page.locator(".bot-row.selected").getAttribute("data-bot")).toBe(MAIN);
  } finally {
    await app.close();
  }

  // After a restart the conversation is still listed; opening it loads its own page and reads it again.
  const again = await launch({ dataDir, env });
  try {
    const row = again.page.locator(".web-row").first();
    await expect(row).toContainText("How do I sort a list");
    await row.locator(".web-row-open").click();
    await until(async () => /\/app\/conv[a-z0-9]+$/.test((await pageURL(again.app)) ?? ""), { what: "the conversation's own page" });
    await expect(again.page.locator(".web-strip .web-status")).toHaveText("Saved for Main bot · 2 messages", { timeout: 15_000 });
    // ✓ settles it: out of the left column, still under Questions.
    await row.locator(".web-settle").click();
    await expect(again.page.locator(".web-row")).toHaveCount(0);
    await expect(again.page.locator(".web-question-row")).toHaveCount(1);
    const list = JSON.parse(readFileSync(join(dataDir, "core", "web", "testai", "conversations.json"), "utf8"));
    expect(list[0].settledAt).toMatch(/Z$/);
    expect(existsSync(join(dataDir, "core", "web", "testai", "how-do-i-sort-a-list.md"))).toBe(true);
  } finally {
    await again.app.close();
  }
});

test("Settings and the plugin panels are never covered by a site's page", async () => {
  const dataDir = tempDir("e2e-web-cover");
  const { app, page } = await launch({ dataDir, env: prepare(dataDir) });
  try {
    await page.locator('.web-site-row[data-site="testai"]').click();
    await until(async () => (await shown(app)).length === 1, { what: "the site's view" });
    await page.locator(".rail-settings button").click();
    await until(async () => (await shown(app)).length === 0, { what: "the view to step aside for Settings" });
    await page.locator(".settings-done").click();
    await until(async () => (await shown(app)).length === 1, { what: "the view back" });
  } finally {
    await app.close();
  }
});
