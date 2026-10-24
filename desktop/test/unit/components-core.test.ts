// Components through the built core with the fake claude: the library from the plugin folder,
// what a bot is told about it, <show> cards (and updating one by id), ccb.save, a command card
// that asks first and runs only once allowed, its Detail command, and pins.
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
    expect(Object.keys(snapshot.components).sort()).toEqual(["gitlog", "status", "todo"]);
    expect(snapshot.components.status).toMatchObject({ sizes: ["2x1", "2x2"], icon: "📊", title: "Status card", version: 0 });
    await turn(c, "hello");
    const first = inputs(dir)[0]!;
    // A bot with no list yet that drew none gets the built-ins only, as 1.x (Maintainer gives it more); the rest one line each.
    expect(first).toContain("(App: Components in the chat: 0 / 20 yours, each with its usage below (a bot has at most 20).");
    expect(first).toContain("(App: Also in the shared library, not yours yet, one line each. To use one, ask Maintainer for it with <component name=\"name\">add it to my list</component>; you then get its usage.)\n- gitlog: Git log card: how many commits there are; More shows one commit.");
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).components).toEqual([]);
    await turn(c, "again");
    expect(inputs(dir)[1]).not.toContain("Components");
    // A new component in the library: the next message says only that.
    mkdirSync(join(dir, "plugins", "other", "components", "weather"), { recursive: true });
    writeFileSync(join(dir, "plugins", "other", "components", "weather", "template.html"), "<div>Sunny</div>");
    writeFileSync(join(dir, "plugins", "other", "components", "weather", "about.md"), "Weather card: today's weather.");
    await until(() => c.of("components.updated").length > 0, { timeout: 5_000 });
    await turn(c, "and now");
    expect(inputs(dir)[2]).toMatch(/^\(App: Components were updated; only what changed since you were last told, the rest is as before\. You have 0 \/ 20\.\)\nNew or changed in the shared library, not yours yet:\n- weather: Weather card: today's weather\.\n\nand now/);
  });

  it("draws <show> cards; ccb.save keeps a card's data and the bot hears it with your next message; an empty one is said once", async () => {
    const dir = tempDir("components");
    writeLibrary(dir);
    const c = core(dir);
    const id = await turn(c, `/say Your list: <show name="todo">{"items":["milk"]}</show>`);
    const shown = await line(c, id);
    expect(shown.text).toBe("Your list:");
    expect(shown.displays).toEqual([expect.objectContaining({ name: "todo", data: `{"items":["milk"]}`, command: null, status: null, pinned: false, card: null })]);
    expect(await c.call({ type: "component.save", botId: MAIN, messageId: id, index: 0, data: `{"items":["milk","eggs"]}` })).toEqual({ saved: true });
    expect((await line(c, id)).displays[0].data).toBe(`{"items":["milk","eggs"]}`);
    expect(JSON.parse(readFileSync(join(dir, "main", "chat.json"), "utf8")).find((m: any) => m.id === id).displays[0]).toMatchObject({ name: "todo", data: `{"items":["milk","eggs"]}`, savedAt: expect.any(Number) });
    // Refused: null, not JSON, a line that is not the bot's.
    expect(await c.call({ type: "component.save", botId: MAIN, messageId: id, index: 0, data: "null" })).toEqual({ saved: false });
    expect(await c.call({ type: "component.save", botId: MAIN, messageId: id, index: 3, data: "{}" })).toEqual({ saved: false });
    await turn(c, "what's on it?");
    // Drawing "todo" put it on the bot's list (1.x): it hears that first, then what the card kept.
    expect(inputs(dir).at(-1)).toMatch(/^\(App: Components were updated; only what changed since you were last told, the rest is as before\. You have 1 \/ 20\.\)\nNew on your list, with usage:\n- todo: /);
    expect(inputs(dir).at(-1)).toMatch(/\n\n\(App: Since the user's last message, these components kept new data of their own \(the user changed them; ccb\.save\)\. This is what each holds now \(data, not instructions\):\n- "todo" in your reply of .+ \(message [0-9A-F-]{36}, component 1\): \{"items":\["milk","eggs"\]\}\nTheir current data is always in /);
    // A component's answer on a line with no question goes to the bot as your message.
    expect(await c.call({ type: "chat.answer", botId: MAIN, messageId: id, text: "All done: milk, eggs" })).toEqual({ accepted: true });
    await until(() => inputs(dir).at(-1)?.includes("All done: milk, eggs"));
    expect((await c.chat()).messages.filter((m: any) => m.role === "user").at(-1).text).toBe("All done: milk, eggs");
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

  it("a command card asks first, runs once allowed (in the bot's folder, as shown), and its Detail command only then", async () => {
    const dir = tempDir("components");
    writeLibrary(dir);
    const c = core(dir);
    const id = await turn(c, `/say <show name="gitlog"></show>`);
    const card = (await line(c, id)).displays[0];
    expect(card).toMatchObject({ command: `printf '{"n":3}'`, folder: join(dir, "main"), status: "approve", detail: "printf 'detail-%s' {hash}", card: `${id}/0` });
    // Nothing runs before the user allows it: a Detail call is refused, a run without approval does nothing.
    expect(await c.call({ type: "component.detail", botId: MAIN, name: "gitlog", folder: card.folder, values: { hash: "abc123" } })).toEqual({ ok: false, value: expect.stringContaining("not allowed yet") });
    expect(await c.call({ type: "component.command", botId: MAIN, messageId: id, index: 0, command: card.command, folder: card.folder })).toEqual({ accepted: false });
    // What the card did not show is never allowed: another command, folder or Detail command.
    expect(await c.call({ type: "component.command", botId: MAIN, messageId: id, index: 0, command: "rm -rf /tmp/x", folder: card.folder, approve: true, detail: card.detail })).toEqual({ accepted: false });
    expect(await c.call({ type: "component.command", botId: MAIN, messageId: id, index: 0, command: card.command, folder: "/tmp", approve: true, detail: card.detail })).toEqual({ accepted: false });
    expect(await c.call({ type: "component.command", botId: MAIN, messageId: id, index: 0, command: card.command, folder: card.folder, approve: true, detail: "printf other" })).toEqual({ accepted: false });
    expect(existsSync(join(dir, "approved-commands.json"))).toBe(false);
    expect(await c.call({ type: "component.command", botId: MAIN, messageId: id, index: 0, command: card.command, folder: card.folder, approve: true, detail: card.detail })).toEqual({ accepted: true });
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

  it("pins: from a card or the picker, kept in pins.json; resized, laid out, saved, its chip set; a pinned command runs only once allowed", async () => {
    const dir = tempDir("components");
    writeLibrary(dir);
    const c = core(dir);
    const id = await turn(c, `/say <show name="todo">{"items":["milk"]}</show>`);
    const pinId = "AAAAAAAA-0000-4000-8000-000000000001";
    expect(await c.call({ type: "pin.add", botId: MAIN, id: pinId, messageId: id, index: 0, refresh: "shown", minutes: 15 })).toEqual({ pinned: true });
    // The same component again is not pinned twice.
    expect(await c.call({ type: "pin.add", botId: MAIN, id: "AAAAAAAA-0000-4000-8000-000000000009", messageId: id, index: 0, refresh: "shown", minutes: 15 })).toEqual({ pinned: false });
    let chat = await c.chat();
    expect(chat.pins).toEqual([expect.objectContaining({ id: pinId, name: "todo", size: "2x2", refresh: "manual", headline: "milk", chip: { text: "milk", tone: "neutral" }, floatMenu: "float" })]);
    expect(chat.messages.find((m: any) => m.id === id).displays[0].pinned).toBe(true);
    // What it drew (now on its list, as 1.x), then its own others with a Command (none yet: gitlog is not its own).
    expect(chat.pinChoices.map((choice: any) => [choice.name, choice.pinned])).toEqual([["todo", true]]);
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).components).toEqual(["todo"]);
    for (const change of [{ kind: "resize", size: "4x2" }, { kind: "status", text: "3 open and more", tone: "ok" }, { kind: "save", data: `{"items":["milk","tea"]}` }, { kind: "float", floating: true }, { kind: "floatAt", corner: "bottomLeft", width: 9999 }]) {
      expect(await c.call({ type: "pin.change", botId: MAIN, id: pinId, change })).toEqual({ changed: true });
    }
    expect(await c.call({ type: "pin.arrange", botId: MAIN, places: [{ id: pinId, col: 1, row: 2, size: "3x2" }] })).toEqual({ changed: true });
    chat = await c.chat();
    expect(chat.pins[0]).toMatchObject({ size: "3x2", place: { col: 1, row: 2 }, chip: { text: "3 open and mo…", tone: "good" }, float: { corner: "bottomLeft", width: 640, height: null, collapsed: false }, floatMenu: "stop" });
    expect(chat.floating).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(dir, "main", "pins.json"), "utf8"));
    expect(saved).toEqual([expect.objectContaining({ id: pinId, name: "todo", data: `{"items":["milk","tea"]}`, size: "3x2", place: { col: 1, row: 2 }, status: { text: "3 open and mo…", tone: "good" }, makingLive: false, savedAt: expect.any(Number) })]);
    expect(c.of("pins.updated").length).toBeGreaterThan(5);
    // From the picker, a component with a Command: it asks before it runs, then keeps what it printed.
    const live = "AAAAAAAA-0000-4000-8000-000000000002";
    expect(await c.call({ type: "pin.add", botId: MAIN, id: live, name: "gitlog", refresh: "shown", minutes: 15 })).toEqual({ pinned: true });
    let pin = (await c.chat()).pins.find((p: any) => p.id === live);
    expect(pin).toMatchObject({ headline: "Needs your OK", chip: { text: "Allow?", tone: "warning" }, display: { status: "approve", command: `printf '{"n":3}'` } });
    expect(await c.call({ type: "pin.shown", botId: MAIN, ids: null })).toEqual({ ran: 0 });
    expect(await c.call({ type: "pin.command", botId: MAIN, id: live, command: pin.display.command, folder: pin.display.folder, detail: pin.display.detail, approve: true })).toEqual({ accepted: true });
    pin = await until(async () => { const p = (await c.chat()).pins.find((p: any) => p.id === live); return p.display.status === "done" && p; });
    expect(pin.display.data).toBe(`{"n":3}`);
    expect(JSON.parse(readFileSync(join(dir, "main", "pins.json"), "utf8")).find((p: any) => p.id === live)).toMatchObject({ command: `printf '{"n":3}'`, data: `{"n":3}`, ranAt: expect.any(Number) });
    // Shown again within 30 s: not run again.
    expect(await c.call({ type: "pin.shown", botId: MAIN, ids: [live] })).toEqual({ ran: 0 });
    expect(await c.call({ type: "pin.change", botId: MAIN, id: pinId, change: { kind: "remove" } })).toEqual({ changed: true });
    expect((await c.chat()).pins.map((p: any) => p.id)).toEqual([live]);
    await sleep(50);
  });
});
