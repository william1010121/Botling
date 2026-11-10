// Live cards in a bot's note, through the built core and the real plugin host: a plugin with "files" (the Note tab's kind)
// reads the note's `<show>` lines with what each draws now (`notes.cards`), lists the bot's components for its insert menu
// (`notes.components`), runs a card's command only once the user allowed it on the app page's ApprovalSheet (the same
// approved-commands.json as the chat's cards) and hears each run (`noteCardChanged`); "freeze to image" keeps main's
// picture in the note's note-assets (`plugins.noteSnapshot`).
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { writeLibrary } from "../fixtures/components";

const harnesses: CoreHarness[] = [];
function core(dir: string) {
  const harness = new CoreHarness(dir, { FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"), BOTLING_ROUTINE_TICK_MS: "0", BOTLING_PLAIN_SHELL: "1", BOTLING_TEST_SEAL_KEY: "test-key" });
  harnesses.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

/** A plugin whose program part hands each `go` straight to `api.notes.<method>(...args)` and keeps the `noteCardChanged` it hears. */
function notePlugin(dir: string, name: string, permissions: string[]) {
  const folder = join(dir, "plugins", name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, displayName: "Note test", version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", web: "dist/web.js", permissions } }));
  writeFileSync(join(folder, "dist", "web.js"), "export function activate() {}");
  writeFileSync(join(folder, "dist", "host.mjs"), `export function activate(api) {
    const heard = [];
    api.subscriptions.push(
      api.ui.expose("go", ({ method, args }) => api.notes[method](...args)),
      api.ui.expose("heard", () => heard),
      api.events.on("noteCardChanged", (data) => { heard.push(data); }),
    );
  }`);
}

async function turn(c: CoreHarness, text: string) {
  const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text });
  await until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === turnId));
}

describe("cards in a bot's note", () => {
  it("draws each <show> line as the chat would; a command runs only once allowed, by the same approvals; each run is heard", async () => {
    const dir = tempDir("note-cards");
    writeLibrary(dir);
    notePlugin(dir, "notetest", ["files"]);
    notePlugin(dir, "nosy", []);
    const c = core(dir);
    const go = async (method: string, ...args: unknown[]): Promise<any> => (await c.call({ type: "plugins.call", name: "notetest", method: "go", params: { method, args }, from: "frame" })).result;
    await until(async () => (await c.call({ type: "plugins.list" })).host.running && go("read", MAIN).then(() => true, () => false), { timeout: 20_000 });
    await turn(c, `/say Status: <show name="status">{"ok":false}</show>`);

    // The insert menu: the bot's own list first (the built-in preview card), then the rest; Command, Refresh and the chat's last data with each.
    const menu = await go("components", MAIN);
    expect(menu.folder).toEqual(expect.any(String));
    expect(menu.readOnly).toBe(false);
    const byName = Object.fromEntries(menu.components.map((entry: any) => [entry.name, entry]));
    expect(byName.gitlog).toEqual({ name: "gitlog", title: "Git log card", summary: "Git log card: how many commits there are; More shows one commit.", offered: false, command: `printf '{"n":3}'`, every: null, sizes: ["2x2"], icon: null, chatData: null });
    expect(byName.status).toMatchObject({ command: null, sizes: ["2x1", "2x2"], icon: "📊", chatData: '{"ok":false}' });

    const { mtime } = await go("read", MAIN);
    const text = [
      "# Daily",
      '<show name="status">{"ok":true}</show>',
      '<show name="gitlog"></show>',
      "<!-- branch: Plan -->",
      "<!-- route: a -->",
      `<show name="status" command="printf '{&quot;ok&quot;:true}'" refresh="10m"></show>`,
      "<!-- end branch -->",
      '<show name="nope"></show>',
    ].join("\n");
    expect(await go("write", MAIN, text, { base: mtime })).toMatchObject({ saved: true });
    const cards = await go("cards", MAIN);
    const folder = menu.folder;
    expect(cards).toEqual([
      { key: expect.stringMatching(/^note\//), name: "status", exists: true, command: null, folder, every: null, status: "static", data: '{"ok":true}', error: null, ranAt: null, images: {}, chatData: '{"ok":false}' },
      { key: expect.stringMatching(/^note\//), name: "gitlog", exists: true, command: `printf '{"n":3}'`, folder, every: null, status: "approve", data: "null", error: null, ranAt: null, images: {}, chatData: null },
      { key: expect.stringMatching(/^note\//), name: "status", exists: true, command: `printf '{"ok":true}'`, folder, every: 600, status: "approve", data: "null", error: null, ranAt: null, images: {}, chatData: '{"ok":false}' },
      { key: expect.stringMatching(/^note\//), name: "nope", exists: false, command: null, folder, every: null, status: "static", data: "null", error: null, ranAt: null, images: {}, chatData: null },
    ]);
    // The same as notes.parse reads the note (what bots are told).
    const parsed = await go("parse", text, { Plan: "a" });
    expect(parsed.cards.map((card: any) => card.key)).toEqual(cards.map((card: any) => card.key));
    expect(parsed.forks).toEqual([expect.objectContaining({ key: "Plan", routes: [expect.objectContaining({ key: "Plan/a" })] })]);
    expect(parsed.cards[2].route).toBe("Plan/a");

    // Not allowed yet: nothing runs; what to ask comes back, and the app page's sheet asks exactly that.
    const gitlog = cards[1].key;
    expect(await go("runCard", MAIN, gitlog)).toEqual({ started: false, needsApproval: { command: `printf '{"n":3}'`, folder, card: "gitlog" } });
    expect(await go("runCard", MAIN, cards[0].key)).toEqual({ started: false, needsApproval: null });
    await expect(go("runCard", MAIN, "note/0000000000000000-1")).rejects.toThrow("No such card in the note.");
    expect((await c.call({ type: "plugins.approvalAsk", name: "notetest", botId: MAIN, command: `printf '{"n":3}'`, folder, card: "gitlog" })).needsApproval)
      .toEqual({ command: `printf '{"n":3}'`, folder, detail: null, card: "Note test: gitlog" });
    expect(await c.call({ type: "plugins.approve", name: "notetest", botId: MAIN, command: `printf '{"n":3}'`, folder })).toEqual({ accepted: true });

    // Allowed: it runs, and the plugin hears the card start and finish.
    expect(await go("runCard", MAIN, gitlog)).toEqual({ started: true, needsApproval: null });
    await until(async () => (await go("cards", MAIN))[1].status === "done");
    expect((await go("cards", MAIN))[1]).toMatchObject({ status: "done", data: '{"n":3}', ranAt: expect.any(Number) });
    const heard = await c.call({ type: "plugins.call", name: "notetest", method: "heard", params: null, from: "frame" });
    expect(heard.result).toEqual([{ botId: MAIN, key: gitlog }, { botId: MAIN, key: gitlog }]);
    // Shown again: not run again; ↻ (force) at most every 2 s.
    expect(await go("runCard", MAIN, gitlog)).toEqual({ started: false, needsApproval: null });
    expect(await go("runCard", MAIN, gitlog, { force: true })).toEqual({ started: false, needsApproval: null });
    // The same command elsewhere is allowed too: one approval per command and folder, as the chat's.
    expect((await go("cards", MAIN, { text: `<show name="gitlog" command="printf '{&quot;n&quot;:3}'"></show>` }))[0].status).toBe("idle");

    // Only a plugin with "files".
    await expect(c.call({ type: "plugins.call", name: "nosy", method: "go", params: { method: "cards", args: [MAIN] }, from: "frame" })).rejects.toThrow(/"files" permission/);
    await expect(c.call({ type: "plugins.call", name: "nosy", method: "go", params: { method: "components", args: [MAIN] }, from: "frame" })).rejects.toThrow(/"files" permission/);
  });

  it("a 網頁預覽卡片 in the note (in a route too) gets what the app adds in the chat: where its frame loads the page, its file URL, name and title", async () => {
    const dir = tempDir("note-preview");
    notePlugin(dir, "notetest", ["files"]);
    const page = join(dir, "work", ".bot", "artifacts", "report.html");
    mkdirSync(dirname(page), { recursive: true });
    writeFileSync(page, "<h1>Report</h1>");
    const c = core(dir);
    const go = async (method: string, ...args: unknown[]): Promise<any> => (await c.call({ type: "plugins.call", name: "notetest", method: "go", params: { method, args }, from: "frame" })).result;
    await until(async () => (await c.call({ type: "plugins.list" })).host.running && go("read", MAIN).then(() => true, () => false), { timeout: 20_000 });
    const text = [
      "<!-- branch: Plan -->",
      "<!-- route: a -->",
      `<show name="網頁預覽卡片">${JSON.stringify({ path: page, title: "架構實驗報告" })}</show>`,
      "<!-- end branch -->",
      `<show name="網頁預覽卡片">${JSON.stringify({ path: join(dir, "work", ".bot", "artifacts", "gone.html") })}</show>`,
    ].join("\n");
    const [shown, gone] = await go("cards", MAIN, { text });
    // Its JSON is shown: no command, nothing to allow.
    expect(shown).toMatchObject({ name: "網頁預覽卡片", exists: true, command: null, status: "static" });
    expect(JSON.parse(shown.data)).toEqual({
      path: page, title: "架構實驗報告", name: "report.html", missing: false,
      url: expect.stringMatching(/^file:\/\/.*report\.html$/), src: expect.stringMatching(/^botling-card:\/\/preview\//),
    });
    expect(gone).toMatchObject({ command: null, status: "static" });
    expect(JSON.parse(gone.data)).toMatchObject({ missing: true, name: "gone.html", title: "gone" });
    expect(JSON.parse(gone.data).src).toBeUndefined();
  });

  it("freeze to image: main's picture of the card goes into the note's note-assets; none taken, or no \"files\": refused", async () => {
    const dir = tempDir("note-snapshot");
    notePlugin(dir, "notetest", ["files"]);
    notePlugin(dir, "nosy", []);
    const c = core(dir);
    await until(async () => (await c.call({ type: "plugins.list" })).host.running, { timeout: 20_000 });
    const note = (await c.call({ type: "plugins.call", name: "notetest", method: "go", params: { method: "read", args: [MAIN] }, from: "frame" })).result.path as string;
    const rect = { x: 10, y: 20, width: 300, height: 120 };
    const picture = { base64: Buffer.from("png bytes").toString("base64"), name: "card.png" };
    const made = await c.call({ type: "plugins.noteSnapshot", name: "notetest", botId: MAIN, rect, picture });
    expect(made).toEqual({ ref: expect.stringMatching(/^note-assets\/[0-9a-f]{32}\.png$/), url: expect.stringMatching(/^botling-card:\/\/image\//) });
    expect(existsSync(join(dirname(note), made.ref))).toBe(true);
    await expect(c.call({ type: "plugins.noteSnapshot", name: "notetest", botId: MAIN, rect })).rejects.toThrow(/No picture/);
    await expect(c.call({ type: "plugins.noteSnapshot", name: "nosy", botId: MAIN, rect, picture })).rejects.toThrow(/"files" permission/);
    await expect(c.call({ type: "plugins.noteSnapshot", name: "notetest", botId: MAIN, rect, picture: { base64: picture.base64, name: "card.html" } })).rejects.toThrow(/Only png/);
  });

  it("openLink: the core says what a note's href names; a file needs \"files\" and must be the bot's or the note's, other schemes are refused", async () => {
    const dir = tempDir("note-open-link");
    notePlugin(dir, "notetest", ["files"]);
    notePlugin(dir, "nosy", []);
    const c = core(dir);
    await until(async () => (await c.call({ type: "plugins.list" })).host.running, { timeout: 20_000 });
    const note = (await c.call({ type: "plugins.call", name: "notetest", method: "go", params: { method: "read", args: [MAIN] }, from: "frame" })).result.path as string;
    mkdirSync(join(dirname(note), "docs"), { recursive: true });
    writeFileSync(join(dirname(note), "docs", "plan.md"), "# Plan");
    const target = (href: string, name = "notetest") => c.call({ type: "plugins.linkTarget", name, botId: MAIN, href });
    expect(await target("https://example.com/x")).toEqual({ kind: "web", url: "https://example.com/x" });
    expect(await target("https://example.com/x", "nosy")).toEqual({ kind: "web", url: "https://example.com/x" });
    const file = await target("docs/plan.md");
    expect(file).toMatchObject({ kind: "file" });
    expect((file as { path: string }).path.endsWith(join("docs", "plan.md"))).toBe(true);
    await expect(target("docs/plan.md", "nosy")).rejects.toThrow(/"files" permission/);
    await expect(target("javascript:alert(1)")).rejects.toThrow(/not opened/);
    await expect(target("/etc/hosts")).rejects.toThrow(/outside/);
  });
});
