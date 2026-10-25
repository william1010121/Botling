// Spike 3: two accounts' websites keep separate cookies, localStorage and IndexedDB, across an app
// restart, and a website gets no Botling bridge. A local HTTP server stands in for real sites.
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launch, post } from "./launch";

let server: Server;
let origin: string;

const page = (script: string) => `<!doctype html><html><body><pre id="out">…</pre><script>
const idb = (write) => new Promise((resolve) => {
  const open = indexedDB.open('acct', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('kv');
  open.onsuccess = () => {
    const tx = open.result.transaction('kv', write === undefined ? 'readonly' : 'readwrite');
    const store = tx.objectStore('kv');
    if (write === undefined) { const get = store.get('v'); get.onsuccess = () => resolve(get.result ?? null); }
    else { store.put(write, 'v'); tx.oncomplete = () => resolve(write); }
  };
  open.onerror = () => resolve('idb error');
});
${script}
</script></body></html>`;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    const value = url.searchParams.get("v") ?? "";
    if (url.pathname === "/set") {
      // A persistent cookie: session cookies (no Max-Age) are not meant to survive a restart.
      response.setHeader("Set-Cookie", `who=${encodeURIComponent(value)}; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax`);
      response.setHeader("Content-Type", "text/html");
      response.end(page(`localStorage.setItem('who', ${JSON.stringify(value)}); idb(${JSON.stringify(value)}).then(() => { out.textContent = 'set'; out.dataset.done = '1'; });`));
    } else if (url.pathname === "/read") {
      response.setHeader("Content-Type", "text/html");
      const cookie = /who=([^;]*)/.exec(request.headers.cookie ?? "")?.[1] ?? null;
      response.end(page(`idb().then((stored) => { out.textContent = JSON.stringify({ cookie: ${JSON.stringify(cookie && decodeURIComponent(cookie))}, local: localStorage.getItem('who'), idb: stored, bridge: typeof window.botling, require: typeof require }); out.dataset.done = '1'; });`));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function openSite(app: ElectronApplication, from: Page, accountId: string, path: string): Promise<Page> {
  const opened = app.waitForEvent("window");
  const response = await post(from, { v: 10, id: `open-${accountId}-${Date.now()}`, cmd: { type: "site.open", accountId, url: `${origin}${path}` } });
  expect(response).toMatchObject({ ok: true });
  const site = await opened;
  await site.waitForSelector("#out[data-done='1']");
  return site;
}

async function read(app: ElectronApplication, from: Page, accountId: string) {
  const site = await openSite(app, from, accountId, "/read");
  const value = JSON.parse((await site.locator("#out").textContent())!);
  await site.close();
  return value;
}

test("accounts are isolated from each other and survive a restart", async () => {
  const first = await launch();
  const accounts = await post(first.page, { v: 10, id: "list", cmd: { type: "accounts.list" } });
  expect(accounts.result.accounts.map((a: { id: string }) => a.id)).toEqual(["work", "personal"]);

  for (const [account, value] of [["work", "alpha"], ["personal", "beta"]] as const) {
    const site = await openSite(first.app, first.page, account, `/set?v=${value}`);
    await site.close();
  }
  expect(await read(first.app, first.page, "work")).toEqual({ cookie: "alpha", local: "alpha", idb: "alpha", bridge: "undefined", require: "undefined" });
  expect(await read(first.app, first.page, "personal")).toEqual({ cookie: "beta", local: "beta", idb: "beta", bridge: "undefined", require: "undefined" });
  // The app's own session has none of it.
  const appCookies = await first.app.evaluate(({ session }) => session.defaultSession.cookies.get({}));
  expect(appCookies).toEqual([]);
  await first.app.close();

  const second = await launch({ dataDir: first.dataDir });
  try {
    expect(await read(second.app, second.page, "work")).toEqual({ cookie: "alpha", local: "alpha", idb: "alpha", bridge: "undefined", require: "undefined" });
    expect(await read(second.app, second.page, "personal")).toEqual({ cookie: "beta", local: "beta", idb: "beta", bridge: "undefined", require: "undefined" });
    // An unknown account is refused, not silently given a fresh session.
    expect(await post(second.page, { v: 10, id: "nope", cmd: { type: "site.open", accountId: "ghost", url: `${origin}/read` } })).toMatchObject({ ok: false, error: { code: "not_found" } });
  } finally {
    await second.app.close();
  }
});
