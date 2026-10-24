// Spike 1: an agent-written card cannot get out of its sandbox, and a legitimate one still works.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { audit, chatFrame, launch } from "./launch";

const VICTIM = "00000000-0000-4000-8000-0000000000A1";
const GOOD = "00000000-0000-4000-8000-0000000000A2";
const EVIL = "00000000-0000-4000-8000-0000000000A3";
const MAIN = "6A0B0000-0000-4000-8000-000000000002";
const victimURL = `botling-card://card/${MAIN}/${VICTIM}/c-victim`;

// Everything a hostile card might try. Results go into the card's own page for the test to read.
const evil = String.raw`<pre id="results">running</pre>
<script>
  const results = {};
  const record = (name, fn) => {
    try {
      const value = fn();
      results[name] = value === undefined ? 'undefined' : (value === null ? 'null' : String(value));
    } catch (error) {
      results[name] = 'threw ' + error.name;
    }
  };
  record('origin', () => self.origin);
  record('window.botling', () => typeof window.botling);
  record('require', () => typeof require);
  record('process', () => typeof process);
  record('parent.botling', () => typeof parent.botling);
  record('parent.document', () => parent.document.title);
  record('top.location read', () => top.location.href);
  record('document.cookie', () => document.cookie);
  record('localStorage', () => localStorage.getItem('x'));
  record('window.open', () => window.open('https://example.com/popup'));
  record('top navigation', () => { top.location.href = 'https://example.com/hijack'; return 'assigned'; });
  // Spoofed identities and raw contract messages: the broker must refuse each.
  parent.postMessage({ ccb: 'save', data: '{"pwned":1}', messageId: '${VICTIM}', cardId: 'c-victim' }, '*');
  parent.postMessage({ ccb: 'save', data: '{"pwned":2}', botId: 'another-bot' }, '*');
  parent.postMessage({ v: 6, id: 'x', cmd: { type: 'chat.send', botId: '${MAIN}', text: 'sent by a card' } }, '*');
  // The app page is the chat page's parent: it must not take the chat page's messages from a card.
  top.postMessage({ botling: 'action', action: { type: 'send', text: 'sent by a card via top' } }, '*');
  top.postMessage({ botling: 'request', id: 1, cmd: { type: 'card.save', botId: '${MAIN}', messageId: '${VICTIM}', cardId: 'c-victim', data: '{"pwned":3}' } }, '*');
  parent.postMessage({ type: 'chat.send', text: 'sent by a card' }, '*');
  parent.postMessage({ ccb: 'save', data: 'not json' }, '*');
  // Well-formed, but asking the core for something it does not grant.
  parent.postMessage({ ccb: 'action', name: 'runShell', value: 'rm -rf ~' }, '*');
  const fetches = ['file:///etc/passwd', 'app://botling/index.html', '${victimURL}', 'http://127.0.0.1:9/'];
  Promise.all(fetches.map((url) => fetch(url).then(() => 'fetched', (error) => 'blocked ' + error.name))).then((outcomes) => {
    fetches.forEach((url, i) => { results['fetch ' + url] = outcomes[i]; });
    const nested = document.createElement('iframe');
    nested.src = 'app://botling/index.html';
    document.body.appendChild(nested);
    results['nested frame'] = 'appended';
    document.getElementById('results').textContent = JSON.stringify(results);
    document.getElementById('results').dataset.done = '1';
    // Last: try to swap itself for another card's page (would inherit this frame's identity).
    setTimeout(() => { location.href = '${victimURL}'; }, 300);
  });
</script>`;

const good = `<button id="save" onclick="ccb.save({ clicks: 1 })">Save</button>
<button id="act" onclick="ccb.action('say', 'hi from good')">Say</button>
<span id="shown"></span>
<script>ccb.onData((d) => { document.getElementById('shown').textContent = JSON.stringify(d); });</script>`;

const victim = `<span id="v"></span><script>ccb.onData((d) => { document.getElementById('v').textContent = JSON.stringify(d); });</script>`;

const date = (Date.now() - Date.UTC(2001, 0, 1)) / 1000;
// The main bot's chat in the Swift app's format, with 2.0's Phase 0 cards on three replies.
const chat = [
  { id: VICTIM, role: "bot", text: "Victim", date, state: "done", cards: [{ id: "c-victim", html: victim, data: '{"secret":"victim"}' }] },
  { id: GOOD, role: "bot", text: "Good", date, state: "done", cards: [{ id: "c-good", html: good, data: null }] },
  { id: EVIL, role: "bot", text: "Evil", date, state: "done", cards: [{ id: "c-evil", html: evil, data: null }] },
];
const savedCard = (dataDir: string, id: string) => JSON.parse(readFileSync(join(dataDir, "core", "main", "chat.json"), "utf8")).find((m: any) => m.id === id).cards[0].data;

test("a hostile card is contained; a legitimate card can save and act", async () => {
  const { app, page, chat: chatView, dataDir } = await launch({ chat });
  try {
    const appUrl = page.url();
    const evilFrame = chatView.frameLocator('[data-card="c-evil"] iframe');
    await expect(evilFrame.locator("#results[data-done='1']")).toBeAttached();
    const results = JSON.parse((await evilFrame.locator("#results").textContent())!);

    expect(results.origin).toBe("null"); // Opaque: sandboxed without allow-same-origin.
    expect(results["window.botling"]).toBe("undefined");
    expect(results.require).toBe("undefined");
    expect(results.process).toBe("undefined");
    expect(results["parent.botling"]).toMatch(/^threw SecurityError$/);
    expect(results["parent.document"]).toMatch(/^threw SecurityError$/);
    expect(results["top.location read"]).toMatch(/^threw SecurityError$/);
    expect(results["document.cookie"]).toMatch(/^threw SecurityError$/);
    expect(results.localStorage).toMatch(/^threw SecurityError$/);
    expect(results["window.open"]).toBe("null");
    expect(results["top navigation"]).toMatch(/^threw /);
    for (const key of Object.keys(results).filter((key) => key.startsWith("fetch "))) expect(results[key]).toMatch(/^blocked/);

    // The page did not move, and no window opened.
    await page.waitForTimeout(800);
    expect(page.url()).toBe(appUrl);
    expect(app.windows()).toHaveLength(1);
    // The card's attempt to swap itself for another card was blocked by main.
    const entries = await audit(app);
    expect(entries.some((entry) => entry.includes(`blocked a frame navigating to ${victimURL}`))).toBe(true);
    await expect(evilFrame.locator("#results[data-done='1']")).toBeAttached(); // Still the evil page, not the victim's.

    // The broker refused every spoof; the core refused the forbidden action.
    const frame = await chatFrame(page);
    const refusals: string[] = await frame.evaluate(() => (window as any).__botlingBroker.refusals.map((r: any) => r.reason));
    expect(refusals.filter((r) => r.startsWith("a message that is not a valid ccb call")).length).toBe(4);
    expect(refusals).toContain("ccb.save with data that is not JSON");
    expect(refusals.some((r) => r.startsWith("the core refused an action: forbidden"))).toBe(true);
    // Nothing reached the chat or the victim's data.
    await expect(chatView.locator(".row.user")).toHaveCount(0);
    await expect(chatView.locator(".row.notice")).toHaveCount(0);
    await expect(chatView.frameLocator('[data-card="c-victim"] iframe').locator("#v")).toHaveText('{"secret":"victim"}');

    // A legitimate card: save goes through broker → main → core and is persisted; action is allowed.
    const goodFrame = chatView.frameLocator('[data-card="c-good"] iframe');
    await expect(async () => {
      await goodFrame.locator("#save").click();
      await expect(goodFrame.locator("#shown")).toHaveText('{"clicks":1}', { timeout: 1_000 });
    }).toPass();
    await expect.poll(() => savedCard(dataDir, GOOD)).toBe('{"clicks":1}');
    await goodFrame.locator("#act").click();
    await expect(chatView.locator(".row.notice").last()).toContainText("A card says: hi from good");

    expect(savedCard(dataDir, VICTIM)).toBe('{"secret":"victim"}');
    // The nested frame inside the card never loaded the app (CSP frame-src 'none'): the only app
    // frames are the app page and its chat page.
    expect(page.frames().filter((frame) => frame.url().startsWith("app://")).map((frame) => frame.url()).sort()).toEqual(["app://botling/chat.html", "app://botling/index.html"]);
  } finally {
    await app.close();
  }
});

test("saved card data comes back after a restart", async () => {
  const { app, chat: chatView, dataDir } = await launch({ chat });
  const frame = chatView.frameLocator('[data-card="c-good"] iframe');
  // In a window that was never shown, input can reach a fresh out-of-process frame before it is
  // hit-testable, so retry the (idempotent) click until it lands.
  await expect(async () => {
    await frame.locator("#save").click();
    await expect(frame.locator("#shown")).toHaveText('{"clicks":1}', { timeout: 1_000 });
  }).toPass();
  await app.close();
  const again = await launch({ dataDir });
  try {
    await expect(again.chat.frameLocator('[data-card="c-good"] iframe').locator("#shown")).toHaveText('{"clicks":1}');
  } finally {
    await again.app.close();
  }
});
