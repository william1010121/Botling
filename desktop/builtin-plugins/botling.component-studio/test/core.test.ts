// Component specs through the built core and its plugin host running botling.component-studio (Phase 5a; 1.x's Workspace+Specs.swift):
// a bot's <suggest-component> is only a chip until pressed; pressed, Maintainer is handed the first build; its <component-spec> fills the spec;
// the component landing in the library goes on the bot's list and the bot that wrote the reply draws it under that reply. The per-message
// "make component" button no longer lives here (it sends a normal message to the bot, see Web/src/regather.ts): the plugin has no `make`,
// no `open` and no Component spec panel. The chips reach the page as message decorations (`under` the reply); what they ask is `plugins.call`.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../../../test/helpers";
import { CoreHarness, MAIN } from "../../../test/core-harness";

const MAINTAINER = "DEC0DE00-0000-4000-8000-00000000DEC0";
const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null) await harness.kill("SIGTERM"); });
function core(dir: string, env: Record<string, string> = {}) {
  const harness = new CoreHarness(dir, {
    BOTLING_COMPONENT_SCAN_MS: "150", FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env,
  });
  harnesses.push(harness);
  return harness;
}
const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const texts = (dir: string) => lines(join(dir, "claude-input.log")).map((entry) => String(entry.text ?? ""));
function component(dir: string, name: string, about: string) {
  const folder = join(dir, "plugins", "ccb-components", "components", name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "template.html"), `<div>${name}</div>`);
  writeFileSync(join(folder, "about.md"), about);
}
async function say(c: CoreHarness, botId: string, text: string) {
  await until(async () => { const chat = await c.chat(botId); return !chat.running && !chat.messages.some((m: any) => m.state === "streaming"); });
  const { turnId } = await c.call({ type: "chat.send", botId, text });
  await until(() => c.of("turn.finished").find((e: any) => e.event.turnId === turnId), { what: `turn ${turnId}` });
}
const reply = async (c: CoreHarness, text: string) => (await c.chat()).messages.findLast((m: any) => m.role === "bot" && m.text === text);

const NAME = "botling.component-studio";
/** What the web part's chips and the panel ask the program part (`ui.expose`), as the app page relays them. */
const act = async (c: CoreHarness, method: string, params: Record<string, unknown> = {}): Promise<any> =>
  (await c.call({ type: "plugins.call", name: NAME, method, params, from: "chat" }, { timeout: 30_000 })).result;
/** The plugin host has loaded the plugin (events before that are kept, but calls wait for it). */
const ready = (c: CoreHarness) => until(async () => (await c.call({ type: "plugins.list" })).host.running, { timeout: 20_000 });
/** The chips under a reply, as the page gets them (its decorations). */
const chipsOf = async (c: CoreHarness, messageId: string): Promise<any[]> =>
  ((await c.chat()).decorations ?? []).filter((d: any) => d.plugin === NAME && d.under === messageId).flatMap((d: any) => d.data.specs);

const pressedChip = async (c: CoreHarness, text: string, line: string) => {
  await say(c, MAIN, text);
  const record = await reply(c, line);
  const chip = await until(async () => (await chipsOf(c, record.id))[0]);
  return { record, chip };
};

describe("component specs (Workspace+Specs.swift)", () => {
  it("the plugin no longer has the per-message make command, the spec panel, or any view or menu of its own", async () => {
    const dir = tempDir("specs-nomake");
    const c = core(dir);
    await ready(c);
    await say(c, MAIN, "/say Your 3 tests: 2 passed, 1 failed.");
    const line = await reply(c, "Your 3 tests: 2 passed, 1 failed.");
    for (const method of ["make", "open", "say", "edit", "build", "cancel", "testRun", "close", "state"]) {
      await expect(act(c, method, { botId: MAIN, messageId: line.id, id: "x" })).rejects.toThrow(/does not handle/);
    }
    // Nothing was handed to Maintainer and no takeover view opened.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await c.chat(MAINTAINER)).messages.some((m: any) => m.role === "relay")).toBe(false);
    expect((await c.call({ type: "plugins.list" })).takeover).toBeNull();
    expect(texts(dir).some((text) => text.includes("Draw the component"))).toBe(false);
  });

  it("<suggest-component> is a chip only; pressed, Maintainer gets the first build; it lands, goes on the bot's list, and the bot draws it under its reply", async () => {
    const dir = tempDir("specs");
    const c = core(dir, { FAKE_CLAUDE_LOG: join(dir, "start.log") });
    await ready(c);
    const { record, chip } = await pressedChip(c, `/say Your 3 tests: 2 passed, 1 failed. <suggest-component name="Test Board">see the tests at a glance, from the test command</suggest-component>`, "Your 3 tests: 2 passed, 1 failed.");
    expect(chip).toMatchObject({ name: "test-board", status: "draft", suggested: true });
    // Nothing went to Maintainer until pressed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await c.chat(MAINTAINER)).messages.some((m: any) => m.role === "relay")).toBe(false);
    await act(c, "press", { id: chip.id });
    const building = await until(async () => { const found = (await chipsOf(c, record.id))[0]; return found?.status === "building" ? found : null; });
    expect(building).toMatchObject({ id: chip.id, name: "test-board", suggested: false, component: null });
    expect("open" in building).toBe(false);
    // Maintainer got the first build, straight from the reply: no copy of the writer's session is started.
    const relay = await until(async () => (await c.chat(MAINTAINER)).messages.find((m: any) => m.role === "relay"), { timeout: 10_000, what: "the request" });
    expect(relay.text).toContain(`(Component spec ${chip.id}; action: build-first) Build the first version now.`);
    expect(relay.text).not.toContain("brief for you");
    expect(lines(join(dir, "start.log")).filter((start) => start.args.includes("--fork-session"))).toHaveLength(0);
    const saved = JSON.parse(readFileSync(join(dir, "main", "specs.json"), "utf8"))[0];
    expect(saved).toMatchObject({ id: chip.id, messageID: record.id, name: "test-board", status: "building", asked: true, bots: ["Main bot"],
      samples: [{ label: "This reply", kind: "reply" }], conversation: [{ kind: "event", text: "Sent to Maintainer to build the first version" }] });
    expect(saved.brief).toBeUndefined();
    // Its answer names what it built; the component lands in the library.
    await until(async () => !(await c.chat(MAINTAINER)).running);
    await say(c, MAINTAINER, `/say Built test-board. <component-spec id="${chip.id}">{"name": "test-board", "about": "Tests at a glance", "fields": [{"name": "passed", "type": "int"}]}</component-spec>`);
    component(dir, "test-board", "Tests at a glance.\nData: {\"passed\": 2}");
    const done = await until(async () => { const found = (await chipsOf(c, record.id))[0]; return found?.status === "done" && found.display?.data === '{"filled":true}' ? found : null; }, { timeout: 15_000, what: "the built component under the reply" });
    expect(done).toMatchObject({ name: "test-board", component: "test-board", filling: null, undo: "undo" });
    expect(done.display).toMatchObject({ name: "test-board", data: '{"filled":true}' });
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).components).toContain("test-board");
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "notice" && m.text === "test-board added to Main bot."));
    // The bot that wrote the reply was asked to draw it, quietly (no line of its own for that turn).
    expect(texts(dir).some((text) => text.includes(`(App: Draw the component "test-board" for your reply from `) && text.includes(`("Your 3 tests: 2 passed, 1 failed."): the user made that reply into this component, for this: see the tests at a glance, from the test command.`))).toBe(true);
    const spec = JSON.parse(readFileSync(join(dir, "main", "specs.json"), "utf8"))[0];
    expect(spec).toMatchObject({ status: "done", built: "test-board", version: 1, filledBy: "Main bot", filled: '{"filled":true}', about: "Tests at a glance" });
    expect(spec.conversation.map((entry: any) => entry.text)).toEqual([
      "Sent to Maintainer to build the first version", "Built test-board.", "test-board added to Main bot", "Asked Main bot to fill it from its reply", "Filled by Main bot",
    ]);
    expect((await c.chat()).messages.filter((m: any) => m.role === "bot").map((m: any) => m.text)).toEqual(["Your 3 tests: 2 passed, 1 failed."]);
    // No panel: nothing was pushed to one and no takeover view opened.
    expect(c.of("plugins.emit").map((e: any) => e.event).filter((e: any) => e.plugin === NAME && e.name === "spec")).toEqual([]);
    expect((await c.call({ type: "plugins.list" })).takeover).toBeNull();
  });
});

describe("anti-nag rules and Undo/Restore (ADR-006 M4)", () => {
  it("a one-shot suggestion gets no chip; one for a component the bot lacks offers the library's; Undo takes it off the list and Restore puts it back", async () => {
    const dir = tempDir("specs-m4");
    component(dir, "disk-usage", "Shows how full the disk is.\n");
    const c = core(dir);
    await ready(c);
    await say(c, MAIN, `/say A table. <suggest-component name="Invoices">a one-off table of this week's invoices</suggest-component>`);
    const oneShot = await reply(c, "A table.");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await chipsOf(c, oneShot.id)).toHaveLength(0);

    // Take disk-usage off the main bot's list (it starts with the whole library), then suggest it.
    const before = JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8"));
    writeFileSync(join(dir, "main", "bot.json"), JSON.stringify({ ...before, components: [] }));
    await c.kill("SIGTERM");
    const again = core(dir);
    await ready(again);
    await say(again, MAIN, `/say Disk is 80% full. <suggest-component name="disk-usage">how full the disk is, from df -h</suggest-component>`);
    const line = await reply(again, "Disk is 80% full.");
    const chip = await until(async () => (await chipsOf(again, line.id))[0]);
    expect(chip).toMatchObject({ name: "disk-usage", status: "draft", suggested: true });
    // The library has it: Pressing only puts it on the list; Maintainer is never asked to build.
    await act(again, "press", { id: chip.id });
    const done = await until(async () => { const found = (await chipsOf(again, line.id))[0]; return found?.status === "done" ? found : null; });
    expect(done.undo).toBe("undo");
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).components).toContain("disk-usage");
    expect((await again.chat(MAINTAINER)).messages.some((m: any) => m.role === "relay")).toBe(false);

    await act(again, "undo", { id: chip.id });
    const undone = await until(async () => { const found = (await chipsOf(again, line.id))[0]; return found?.undo === "restore" ? found : null; });
    expect(undone.component ?? null).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).components).not.toContain("disk-usage");
    expect(existsSync(join(dir, "plugins", "ccb-components", "components", "disk-usage", "template.html"))).toBe(true);

    await act(again, "restore", { id: chip.id });
    await until(async () => (await chipsOf(again, line.id))[0]?.undo === "undo");
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).components).toContain("disk-usage");
  });
});

describe("a built component's command is allowed only on the app page's ApprovalSheet (G2)", () => {
  it("the command asks what the sheet asks; a different command or folder is not accepted; the sheet's Allow (plugins.approve) lets it run", async () => {
    const dir = tempDir("specs-approve");
    const c = core(dir, { BOTLING_PLAIN_SHELL: "1" });
    await ready(c);
    const { chip } = await pressedChip(c, `/say Disk is 80% full. <suggest-component name="disk-usage">how full the disk is</suggest-component>`, "Disk is 80% full.");
    await act(c, "press", { id: chip.id });
    await until(async () => (await c.chat(MAINTAINER)).messages.find((m: any) => m.role === "relay"), { timeout: 10_000, what: "the request" });
    await until(async () => !(await c.chat(MAINTAINER)).running);
    // Maintainer builds it with a command; the library copy has the same Command line.
    await say(c, MAINTAINER, `/say Built disk-usage. <component-spec id="${chip.id}">{"name": "disk-usage", "about": "How full the disk is", "command": "printf '{\\"used\\": 80}'"}</component-spec>`);
    component(dir, "disk-usage", "Shows how full the disk is.\nCommand: printf '{\"used\": 80}'\n");
    await until(async () => { const found = (await c.chat()).decorations?.flatMap((d: any) => d.data?.specs ?? []).find((s: any) => s.id === chip.id); return found?.status === "done" ? found : null; }, { timeout: 15_000, what: "the built component" });
    const command = `printf '{"used": 80}'`;
    const folder = JSON.parse(readFileSync(join(dir, "main", "specs.json"), "utf8"))[0].folder;
    expect(await act(c, "command", { id: chip.id, command, folder })).toEqual({ accepted: false, needsApproval: { command, folder, detail: null, card: "disk-usage" } });
    // What the sheet shows is the core's: a frame or web part asking about this folder is answered by the core, and nothing is allowed by asking.
    expect(await c.call({ type: "plugins.approvalAsk", name: NAME, botId: MAIN, command, folder, card: "disk-usage", from: "chat" })).toEqual({ needsApproval: { command, folder, detail: null, card: "disk-usage" } });
    // Another plugin's web part may not ask from the chat page.
    await expect(c.call({ type: "plugins.approvalAsk", name: "botling.git", botId: MAIN, command, folder, from: "chat" })).rejects.toThrow(/may not ask for approval/);
    expect(await act(c, "command", { id: chip.id, command: "rm -rf /tmp/x", folder })).toEqual({ accepted: false });
    expect(await act(c, "command", { id: chip.id, command, folder: "/tmp" })).toEqual({ accepted: false });
    expect(existsSync(join(dir, "approved-commands.json"))).toBe(false);
    // Only the sheet's Allow records it (it sends plugins.approve with the core's command and folder); then the card asks c.
    expect(await c.call({ type: "plugins.approve", name: NAME, botId: MAIN, command, folder })).toEqual({ accepted: true });
    expect(await act(c, "command", { id: chip.id, command, folder })).toEqual({ accepted: true });
  });
});
