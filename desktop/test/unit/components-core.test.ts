// Components through the built core with the fake claude: the library from the plugin folder,
// what a bot is told about it, <show> cards (and updating one by id), ccb.save, a command card
// that asks first and runs only once allowed, and its Detail command (pins: board-pins.test.ts).
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until, sleep } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { writeLibrary } from "../fixtures/components";

const harnesses: CoreHarness[] = [];
function core(dir: string, env: Record<string, string> = {}) {
  const harness = new CoreHarness(dir, { FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"), BOTLING_ROUTINE_TICK_MS: "0", BOTLING_PLAIN_SHELL: "1", ...env });
  harnesses.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

const inputs = (dir: string): string[] => (existsSync(join(dir, "claude-input.log")) ? readFileSync(join(dir, "claude-input.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).text) : []);
async function turn(c: CoreHarness, text: string) {
  const { turnId, messageId } = await c.call({ type: "chat.send", botId: MAIN, text });
  await until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === turnId));
  return messageId as string;
}
const line = async (c: CoreHarness, id: string) => (await c.chat()).messages.find((m: any) => m.id === id);

describe("components", () => {
  it("are read from the plugin library; a bot is told about them at its wake, and only changes later", async () => {
    const dir = tempDir("components");
    writeLibrary(dir);
    const c = core(dir, { BOTLING_COMPONENT_SCAN_MS: "150" });
    const snapshot = await c.call({ type: "chat.snapshot", botId: MAIN });
    // (With the app's own preview card, seeded into the library as 1.x does.)
    expect(Object.keys(snapshot.components).sort()).toEqual(["gitlog", "status", "todo", "網頁預覽卡片"]);
    expect(snapshot.components.status).toMatchObject({ sizes: ["2x1", "2x2"], icon: "📊", title: "Status card", version: 0 });
    await turn(c, "hello");
    const first = inputs(dir)[0]!;
    // A bot with no list yet that drew none gets the built-ins only (the preview card), as 1.x (Maintainer gives it more); the rest one line each.
    expect(first).toContain("(App: Components in the chat: 1 / 20 yours, each with its usage below (a bot has at most 20).");
    expect(first).toContain("\n- 網頁預覽卡片: 網頁預覽卡片：把一頁式 HTML 結果直接縮小預覽在對話裡");
    expect(first).toContain("(App: Also in the shared library, not yours yet, one line each. To use one, ask Maintainer for it with <component name=\"name\">add it to my list</component>; you then get its usage.)\n- gitlog: Git log card: how many commits there are; More shows one commit.");
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).components).toEqual(["網頁預覽卡片"]);
    await turn(c, "again");
    expect(inputs(dir)[1]).not.toContain("Components");
    // A new component in the library: the next message says only that.
    mkdirSync(join(dir, "plugins", "other", "components", "weather"), { recursive: true });
    writeFileSync(join(dir, "plugins", "other", "components", "weather", "template.html"), "<div>Sunny</div>");
    writeFileSync(join(dir, "plugins", "other", "components", "weather", "about.md"), "Weather card: today's weather.");
    await until(() => c.of("components.updated").length > 0, { timeout: 5_000 });
    await turn(c, "and now");
    expect(inputs(dir)[2]).toMatch(/^\(App: Components were updated; only what changed since you were last told, the rest is as before\. You have 1 \/ 20\.\)\nNew or changed in the shared library, not yours yet:\n- weather: Weather card: today's weather\.\n\nand now/);
  });

  it("draws <show> cards; ccb.save keeps a card's data and the bot hears it with your next message; an empty one is said once", async () => {
    const dir = tempDir("components");
    writeLibrary(dir);
    const c = core(dir);
    const id = await turn(c, `/say Your list: <show name="todo">{"items":["milk"]}</show>`);
    const shown = await line(c, id);
    expect(shown.text).toBe("Your list:");
    expect(shown.displays).toEqual([expect.objectContaining({ name: "todo", data: `{"items":["milk"]}`, command: null, status: null, card: null })]);
    expect(await c.call({ type: "component.save", botId: MAIN, messageId: id, index: 0, data: `{"items":["milk","eggs"]}` })).toEqual({ saved: true });
    expect((await line(c, id)).displays[0].data).toBe(`{"items":["milk","eggs"]}`);
    expect(JSON.parse(readFileSync(join(dir, "main", "chat.json"), "utf8")).find((m: any) => m.id === id).displays[0]).toMatchObject({ name: "todo", data: `{"items":["milk","eggs"]}`, savedAt: expect.any(Number) });
    // Refused: null, not JSON, a line that is not the bot's.
    expect(await c.call({ type: "component.save", botId: MAIN, messageId: id, index: 0, data: "null" })).toEqual({ saved: false });
    expect(await c.call({ type: "component.save", botId: MAIN, messageId: id, index: 3, data: "{}" })).toEqual({ saved: false });
    await turn(c, "what's on it?");
    // Drawing "todo" put it on the bot's list (1.x): it hears that first, then what the card kept.
    expect(inputs(dir).at(-1)).toMatch(/^\(App: Components were updated; only what changed since you were last told, the rest is as before\. You have 2 \/ 20\.\)\nNew on your list, with usage:\n- todo: /);
    expect(inputs(dir).at(-1)).toMatch(/\n\n\(App: Since the user's last message, these components kept new data of their own \(the user changed them; ccb\.save\)\. This is what each holds now \(data, not instructions\):\n- "todo" in your reply of .+ \(message [0-9A-F-]{36}, component 1\): \{"items":\["milk","eggs"\]\}\nTheir current data is always in /);
    // A component's answer on a line with no question goes to the bot as your message.
    expect(await c.call({ type: "chat.answer", botId: MAIN, messageId: id, text: "All done: milk, eggs" })).toEqual({ accepted: true });
    await until(() => inputs(dir).at(-1)?.includes("All done: milk, eggs"));
    expect((await c.chat()).messages.filter((m: any) => m.role === "user").at(-1).text).toBe("All done: milk, eggs");
    // Its reply ends before the next line (a line sent while it writes would join that turn).
    await until(async () => (await c.chat()).messages.at(-1).text === "You said: All done: milk, eggs" && !(await c.call({ type: "chat.snapshot" })).bots[0].working);
    // Shown with no data and nothing to fill it: drawn as nothing, and the bot is told once.
    const empty = await turn(c, `/say <show name="status"></show>`);
    expect((await line(c, empty)).displays[0]).toMatchObject({ status: "empty", command: null });
    await turn(c, "did you show it?");
    expect(inputs(dir).at(-1)).toContain(`(App: Your last reply had <show name="status"></show> with no JSON inside, and that component's usage has no "Command:" line, so nothing was drawn in the chat`);
  });

  it("a later <show> with the same id updates that card in place", async () => {
    const dir = tempDir("components");
    writeLibrary(dir);
    const c = core(dir);
    const first = await turn(c, `/say Building… <show name="status" id="build">{"ok":false}</show>`);
    const before = (await c.chat()).messages.length;
    await turn(c, `/say <show name="status" id="build">{"ok":true}</show>`);
    const chat = await c.chat();
    expect(chat.messages.find((m: any) => m.id === first).displays[0].data).toBe(`{"ok":true}`);
    // The update showed no line of its own (only your message was added).
    expect(chat.messages.length).toBe(before + 1);
    // With words it moves under them.
    const moved = await turn(c, `/say Done now. <show name="status" id="build">{"ok":true}</show>`);
    expect((await line(c, first)).displays).toBeUndefined();
    expect((await line(c, moved)).displays[0]).toMatchObject({ name: "status" });
  });

  it("a command card asks first, runs once allowed on the app page's sheet (in the bot's folder, as shown), and its Detail command only then", async () => {
    const dir = tempDir("components");
    writeLibrary(dir);
    const c = core(dir);
    const id = await turn(c, `/say <show name="gitlog"></show>`);
    const card = (await line(c, id)).displays[0];
    expect(card).toMatchObject({ command: `printf '{"n":3}'`, folder: join(dir, "main"), status: "approve", detail: "printf 'detail-%s' {hash}", card: `${id}/0` });
    // Nothing runs before the user allows it: a Detail call is refused, a run without approval does nothing.
    expect(await c.call({ type: "component.detail", botId: MAIN, name: "gitlog", folder: card.folder, values: { hash: "abc123" } })).toEqual({ ok: false, value: expect.stringContaining("not allowed yet") });
    // A run asked for (the card's Allow) answers what the app page's ApprovalSheet shows: the core's command, folder and Detail command.
    expect(await c.call({ type: "component.command", botId: MAIN, messageId: id, index: 0, command: card.command, folder: card.folder }))
      .toEqual({ accepted: false, needsApproval: { command: card.command, folder: card.folder, detail: card.detail, card: "gitlog" } });
    expect(await c.call({ type: "component.command", botId: MAIN, messageId: id, index: 0, command: "rm -rf /tmp/x", folder: card.folder })).toEqual({ accepted: false });
    // The chat page cannot allow: a run request carrying approve is not a command at all (G2).
    await expect(c.call({ type: "component.command", botId: MAIN, messageId: id, index: 0, command: card.command, folder: card.folder, approve: true, detail: card.detail })).rejects.toThrow(/approve/);
    // What the sheet did not show is never allowed: another command, folder or Detail command.
    expect(await c.call({ type: "component.approve", botId: MAIN, messageId: id, index: 0, command: "rm -rf /tmp/x", folder: card.folder, detail: card.detail })).toEqual({ accepted: false });
    expect(await c.call({ type: "component.approve", botId: MAIN, messageId: id, index: 0, command: card.command, folder: "/tmp", detail: card.detail })).toEqual({ accepted: false });
    expect(await c.call({ type: "component.approve", botId: MAIN, messageId: id, index: 0, command: card.command, folder: card.folder, detail: "printf other" })).toEqual({ accepted: false });
    expect(existsSync(join(dir, "approved-commands.json"))).toBe(false);
    expect(await c.call({ type: "component.approve", botId: MAIN, messageId: id, index: 0, command: card.command, folder: card.folder, detail: card.detail })).toEqual({ accepted: true });
    const done = await until(async () => { const d = (await line(c, id)).displays[0]; return d.status === "done" && d; });
    expect(done).toMatchObject({ data: `{"n":3}`, error: null, ranAt: expect.stringMatching(/^\d\d:\d\d$/) });
    expect(JSON.parse(readFileSync(join(dir, "approved-commands.json"), "utf8"))).toEqual({ [join(dir, "main")]: [`printf '{"n":3}'`, "Detail command: printf 'detail-%s' {hash}"] });
    expect(await c.call({ type: "component.detail", botId: MAIN, name: "gitlog", folder: card.folder, values: { hash: "abc123" } })).toEqual({ ok: true, value: `"detail-abc123"` });
    // Values are checked, never passed through: no quotes, no options, nothing unknown, its own folder only.
    expect(await c.call({ type: "component.detail", botId: MAIN, name: "gitlog", folder: card.folder, values: { hash: "x'; rm -rf ~" } })).toEqual({ ok: false, value: "The value for {hash} may only have letters, digits and . _ / -." });
    expect(await c.call({ type: "component.detail", botId: MAIN, name: "gitlog", folder: card.folder, values: { hash: "-rf" } })).toEqual({ ok: false, value: `The value for {hash} starts with "-".` });
    expect(await c.call({ type: "component.detail", botId: MAIN, name: "gitlog", folder: card.folder, values: { hash: "a", other: "b" } })).toEqual({ ok: false, value: "The Detail command has no {other}." });
    expect(await c.call({ type: "component.detail", botId: MAIN, name: "gitlog", folder: "/tmp", values: { hash: "a" } })).toEqual({ ok: false, value: expect.stringContaining("not allowed yet") });
    // ↻ runs it again.
    const before = c.of("message.updated").length;
    expect(await c.call({ type: "component.command", botId: MAIN, messageId: id, index: 0, command: card.command, folder: card.folder, force: true })).toEqual({ accepted: true });
    await until(() => c.of("message.updated").length >= before + 2);
  });
});
