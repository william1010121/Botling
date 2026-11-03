// Pins through the built core and the real plugin host with botling.board (the plugin that keeps them since plan stage 2): from a card or the
// picker, resized, laid out, saved, its chip set; a pinned command runs only once the user allowed it on the ApprovalSheet's two commands
// (`plugins.approvalAsk`, `plugins.approve` with the component); what the page draws arrives as `pluginData` with the chat; the core's
// pins.json is imported once and left as it was; a pin's author gates the links its card opens; a problem report says how it refreshes.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until, sleep } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { writeLibrary } from "../fixtures/components";

const harnesses: CoreHarness[] = [];
function core(dir: string, env: Record<string, string> = {}) {
  const harness = new CoreHarness(dir, { FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"), BOTLING_ROUTINE_TICK_MS: "0", BOTLING_PLAIN_SHELL: "1", BOTLING_TEST_SEAL_KEY: "test-key", ...env });
  harnesses.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

const BOARD = "botling.board";
async function turn(c: CoreHarness, text: string) {
  const { turnId, messageId } = await c.call({ type: "chat.send", botId: MAIN, text });
  await until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === turnId));
  return messageId as string;
}
/** What the user did, as the chat page sends it to the plugin's program part. */
const act = async (c: CoreHarness, action: Record<string, unknown>, botId = MAIN) => (await c.call({ type: "plugins.call", name: BOARD, method: "action", params: { botId, action }, from: "chat" })).result;
/** What the chat page draws the Board from. */
const data = async (c: CoreHarness) => ((await c.chat()).pluginData ?? {})[BOARD] as { pins: any[]; floating: any[]; pinChoices: any[] } | undefined;
const ready = (c: CoreHarness) => until(async () => (await c.call({ type: "plugins.list" })).plugins.find((p: any) => p.name === BOARD)?.enabled && (await c.call({ type: "plugins.list" })).host.running && (await data(c)), { timeout: 20_000 });

describe("pins through botling.board", () => {
  it("pin from a card or the picker; resize, lay out, save, set its chip; a pinned command runs only once allowed", async () => {
    const dir = tempDir("board-pins");
    writeLibrary(dir);
    const c = core(dir);
    await ready(c);
    const id = await turn(c, `/say <show name="todo">{"items":["milk"]}</show>`);
    const pinId = "AAAAAAAA-0000-4000-8000-000000000001";
    expect(await act(c, { type: "pin", id: pinId, messageID: id, index: 0, refresh: "shown", minutes: 15 })).toEqual({ pinned: true });
    // The same component again is not pinned twice.
    expect(await act(c, { type: "pin", id: "AAAAAAAA-0000-4000-8000-000000000009", messageID: id, index: 0, refresh: "shown", minutes: 15 })).toEqual({ pinned: false });
    let view = (await until(async () => { const d = await data(c); return d?.pins.length ? d : null; }))!;
    expect(view.pins).toEqual([expect.objectContaining({ id: pinId, name: "todo", size: "2x2", refresh: "manual", headline: "milk", chip: { text: "milk", tone: "neutral" }, floatMenu: "float" })]);
    // What it drew, then its own others with a Command (none yet: gitlog is not its own).
    expect(view.pinChoices.map((choice: any) => [choice.name, choice.pinned])).toEqual([["todo", true]]);
    for (const action of [{ type: "resizePin", id: pinId, size: "4x2" }, { type: "pinStatus", id: pinId, text: "3 open and more", tone: "ok" }, { type: "pinSave", id: pinId, data: `{"items":["milk","tea"]}` },
      { type: "floatPin", id: pinId, floating: true }, { type: "setPinFloat", id: pinId, corner: "bottomLeft", width: 9999 }]) {
      expect(await act(c, action)).toEqual({ changed: true });
    }
    expect(await act(c, { type: "arrangePins", places: [{ id: pinId, col: 1, row: 2, size: "3x2" }] })).toEqual({ changed: true });
    view = (await until(async () => { const d = await data(c); return d?.pins[0]?.size === "3x2" ? d : null; }))!;
    expect(view.pins[0]).toMatchObject({ size: "3x2", place: { col: 1, row: 2 }, chip: { text: "3 open and mo…", tone: "good" }, float: { corner: "bottomLeft", width: 640, height: null, collapsed: false }, floatMenu: "stop" });
    expect(view.floating).toHaveLength(1);
    // The core's pins.json is not the pins' home any more: it was never written.
    expect(existsSync(join(dir, "main", "pins.json"))).toBe(false);
    expect(c.of("chat.pluginData").length).toBeGreaterThan(5);
    // From the picker, a component with a Command: it asks before it runs, then keeps what it printed.
    const live = "AAAAAAAA-0000-4000-8000-000000000002";
    expect(await act(c, { type: "pin", id: live, name: "gitlog", refresh: "shown", minutes: 15 })).toEqual({ pinned: true });
    let pin = (await until(async () => (await data(c))?.pins.find((p: any) => p.id === live)))!;
    expect(pin).toMatchObject({ headline: "Needs your OK", chip: { text: "Allow?", tone: "warning" }, display: { status: "approve", command: `printf '{"n":3}'`, card: `pin/${live}` } });
    expect(await act(c, { type: "pinShown", ids: null })).toEqual({ ran: 0 });
    const ask = { command: pin.display.command, folder: pin.display.folder, detail: pin.display.detail, card: "gitlog" };
    expect(await act(c, { type: "pinCommand", id: live, command: pin.display.command, folder: pin.display.folder })).toEqual({ accepted: false, needsApproval: ask });
    // The sheet: the core says what it shows; a folder it does not run in is refused; Allow approves, and the command then runs.
    expect((await c.call({ type: "plugins.approvalAsk", name: BOARD, botId: MAIN, command: ask.command, folder: ask.folder, card: `pin/${live}`, component: "gitlog" })).needsApproval).toEqual(ask);
    await expect(c.call({ type: "plugins.approvalAsk", name: BOARD, botId: MAIN, command: ask.command, folder: "/tmp", card: `pin/${live}`, component: "gitlog" })).rejects.toThrow(/folder/);
    await expect(c.call({ type: "plugins.approvalAsk", name: BOARD, botId: MAIN, command: ask.command, folder: ask.folder, card: "m1/0", component: "gitlog" })).rejects.toThrow(/key/);
    expect(await c.call({ type: "plugins.approve", name: BOARD, botId: MAIN, command: ask.command, folder: "/tmp", component: "gitlog", detail: ask.detail })).toEqual({ accepted: false });
    expect(await c.call({ type: "plugins.approve", name: BOARD, botId: MAIN, command: ask.command, folder: ask.folder, component: "gitlog", detail: "something else" })).toEqual({ accepted: false });
    expect(await c.call({ type: "plugins.approve", name: BOARD, botId: MAIN, command: ask.command, folder: ask.folder, component: "gitlog", detail: ask.detail })).toEqual({ accepted: true });
    expect(await act(c, { type: "pinCommand", id: live, command: pin.display.command, folder: pin.display.folder })).toEqual({ accepted: true });
    pin = (await until(async () => { const p = (await data(c))?.pins.find((p: any) => p.id === live); return p?.display.status === "done" && p; }))!;
    expect(pin.display.data).toBe(`{"n":3}`);
    // Shown again within 30 s: not run again.
    expect(await act(c, { type: "pinShown", ids: [live] })).toEqual({ ran: 0 });
    expect(await act(c, { type: "unpin", id: pinId })).toEqual({ changed: true });
    expect((await until(async () => { const d = await data(c); return d?.pins.length === 1 ? d : null; }))!.pins.map((p: any) => p.id)).toEqual([live]);
    await sleep(50);
  });

  it("the core's pins.json is imported once and left as it was; the plugin keeps the pins after", async () => {
    const dir = tempDir("board-pins");
    writeLibrary(dir);
    mkdirSync(join(dir, "main"), { recursive: true });
    const legacy = JSON.stringify([{ id: "BBBBBBBB-0000-4000-8000-000000000001", name: "todo", data: `{"items":["milk"]}`, refresh: "manual", minutes: 15, size: "2x2", makingLive: false }]);
    writeFileSync(join(dir, "main", "pins.json"), legacy);
    const c = core(dir);
    await ready(c);
    expect((await until(async () => { const d = await data(c); return d?.pins.length ? d : null; }))!.pins).toEqual([expect.objectContaining({ id: "BBBBBBBB-0000-4000-8000-000000000001", name: "todo", headline: "milk" })]);
    expect(await act(c, { type: "resizePin", id: "BBBBBBBB-0000-4000-8000-000000000001", size: "4x2" })).toEqual({ changed: true });
    expect(readFileSync(join(dir, "main", "pins.json"), "utf8")).toBe(legacy);
  });

  it("a pin's author gates the links its card opens; its component's own bar is not a link", async () => {
    const dir = tempDir("board-pins");
    writeLibrary(dir);
    mkdirSync(join(dir, "main"), { recursive: true });
    const pin = "CCCCCCCC-0000-4000-8000-000000000001";
    writeFileSync(join(dir, "main", "pins.json"), JSON.stringify([{ id: pin, name: "todo", data: "{}", refresh: "manual", minutes: 15, size: "2x2", makingLive: false }]));
    const c = core(dir);
    await ready(c);
    const known = await c.call({ type: "link.authorize", botId: MAIN, pinId: pin, url: "https://example.org/nothing" });
    expect(known).toEqual({ result: false, linked: false });
    // A pin the plugin does not have never authorizes.
    expect(await c.call({ type: "link.authorize", botId: MAIN, pinId: "DDDDDDDD-0000-4000-8000-000000000009", url: "https://example.org/nothing" })).toEqual({ result: false, linked: false });
    // The program part tells the core whose a pin is (and how it refreshes) for a problem report.
    const owner = (await c.call({ type: "plugins.call", name: BOARD, method: "pin.owner", params: { botId: MAIN, id: pin, strict: true }, from: "chat" })).result;
    expect(owner).toMatchObject({ botId: MAIN, linkAuthor: MAIN, words: "no command; keeps the data it was drawn with", when: null });
  });
});
