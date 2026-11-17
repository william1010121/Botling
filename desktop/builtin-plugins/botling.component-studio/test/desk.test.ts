// The component studio's desk (desk.ts) over a studio seam in memory (fake-studio.ts): the scenarios the core's specs.test.ts ran through a
// whole core, now through the plugin's own state machine. A step is one await: `desk.press(...)` returns when everything it did is written.
// The per-message "make component" button is gone from the plugin (it sends a normal message to the bot instead): a spec starts only from a
// bot's <suggest-component> chip, and pressing that chip is what starts the build.
import { describe, expect, it } from "vitest";
import { FILL_TIMING } from "../src/desk";
import { deskOver, FakeStudio, line, MAIN, MAINTAINER } from "./fake-studio";

const UUID = /^[0-9A-F-]{36}$/;
const TESTS = "Your 3 tests: 2 passed, 1 failed.";

/** A chat with the user's question and a bot's reply. */
function reply(studio: FakeStudio, text: string, more: Record<string, unknown> = {}, chat = MAIN) {
  studio.add(chat, line("user", "how are the tests?"));
  return studio.add(chat, line("bot", text, more));
}
const specsOf = (studio: FakeStudio, chat = MAIN) => (studio.stored[chat] ?? []) as any[];
/** A bot's suggestion under its reply, and the chip's spec id. */
async function suggested(studio: FakeStudio, desk: ReturnType<typeof deskOver>["desk"], record: { id: string }, name = "Test Board", draft = "see the tests at a glance, from the test command") {
  await desk.suggest(name, draft, MAIN);
  return specsOf(studio).find((spec) => spec.messageID === record.id).id as string;
}
/** Maintainer's reply and the tag in it, as the host hands them over. */
async function maintainerSays(studio: FakeStudio, desk: ReturnType<typeof deskOver>["desk"], id: string, json: unknown, words: string) {
  studio.add(MAINTAINER, line("bot", words));
  await desk.componentSpec(MAINTAINER, id, JSON.stringify(json));
}

describe("a suggestion chip pressed", () => {
  it("hands the reply straight to Maintainer as the first build, and the chip says Building…", async () => {
    const { studio, desk, chips } = deskOver();
    const record = reply(studio, TESTS);
    const id = await suggested(studio, desk, record);
    expect(id).toMatch(UUID);
    expect(studio.handed).toEqual([]);
    await desk.press(id);
    expect(studio.handed).toHaveLength(1);
    expect(studio.handed[0]).toContain(`(Component spec ${id}; action: build-first) Build the first version now.`);
    expect(studio.handed[0]).toContain("see the tests at a glance, from the test command");
    expect(studio.handed[0]).not.toContain("brief for you");
    const saved = specsOf(studio)[0];
    expect(saved).toMatchObject({
      id, messageID: record.id, name: "test-board", status: "building", asked: true, bots: ["Main bot"], purpose: "see the tests at a glance, from the test command",
      conversation: [{ kind: "event", text: "Sent to Maintainer to build the first version" }],
    });
    expect(saved.brief).toBeUndefined();
    expect(studio.working_).toContainEqual(["test-board", "built from a reply"]);
    const chip = chips(MAIN, record.id)[0]!;
    expect(chip).toMatchObject({ id, name: "test-board", status: "building", suggested: false, component: null });
    expect("open" in chip).toBe(false);
    // Pressed again: nothing more is sent.
    await desk.press(id);
    expect(studio.handed).toHaveLength(1);
  });

  it("builds the first version: it lands, goes on the bot's list, and the bot that wrote the reply draws it under its reply", async () => {
    const { studio, desk, chips } = deskOver();
    const record = reply(studio, TESTS);
    const id = await suggested(studio, desk, record);
    await desk.press(id);
    await maintainerSays(studio, desk, id, { name: "test-board", about: "Tests at a glance", fields: [{ name: "passed", type: "int" }] }, "Built test-board.");
    studio.answer = { kind: "reply", text: `<show name="test-board">{"filled":true}</show>` } as never;
    studio.component("test-board", "Tests at a glance.\nData: {\"passed\": 2}");
    await desk.finishBuilds();
    // Added to Main bot's list, said in its chat; the bot is asked to draw it, quietly.
    expect(studio.chatsById.get(MAIN)!.components).toContain("test-board");
    expect(studio.notices).toContainEqual([MAIN, "test-board added to Main bot."]);
    expect(studio.notes).toContainEqual([MAIN, `(App: The user added the component "test-board" to your list.)`]);
    await desk.run(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    await desk.run(async () => {});
    expect(studio.asks).toHaveLength(1);
    expect(studio.asks[0]!.bot).toBe(MAIN);
    expect(studio.asks[0]!.text.startsWith(`(App: Draw the component "test-board" for your reply from `)).toBe(true);
    expect(studio.asks[0]!.text).toContain(`("${TESTS}"): the user made that reply into this component, for this: see the tests at a glance, from the test command.`);
    const spec = specsOf(studio)[0];
    expect(spec).toMatchObject({ status: "done", built: "test-board", version: 1, filledBy: "Main bot", filled: '{"filled":true}', about: "Tests at a glance" });
    expect(spec.conversation.map((entry: any) => entry.text)).toEqual([
      "Sent to Maintainer to build the first version", "Built test-board.", "test-board added to Main bot", "Asked Main bot to fill it from its reply", "Filled by Main bot",
    ]);
    const chip = chips(MAIN, record.id)[0]!;
    expect(chip).toMatchObject({ name: "test-board", status: "done", component: "test-board", filling: null, undo: "undo" });
    expect(chip.display).toMatchObject({ name: "test-board", data: '{"filled":true}' });
  });

  it("the desk has no make, panel, say, edit, cancel, test-run or open any more (the per-message button sends a normal message to the bot)", () => {
    const { desk } = deskOver();
    for (const gone of ["make", "openSpec", "closePanel", "state", "say", "editValue", "build", "cancel", "testRun", "settleChanges", "draftRequest"]) {
      expect(gone in desk, gone).toBe(false);
    }
    for (const kept of ["suggest", "press", "undo", "restore", "runComponent", "finishBuilds", "componentSpec", "load"]) {
      expect(typeof (desk as any)[kept], kept).toBe("function");
    }
  });
});

describe("<suggest-component>", () => {
  it("is a chip only; Maintainer's tag for an unknown id is said back; only Maintainer's tag counts", async () => {
    const { studio, desk, chips } = deskOver();
    const record = reply(studio, "Disk is 80% full.");
    await desk.suggest("Disk Usage", "how full the disk is, from df -h", MAIN);
    expect(chips(MAIN, record.id)).toEqual([expect.objectContaining({ name: "disk-usage", status: "draft", suggested: true })]);
    expect(studio.handed).toEqual([]);
    const id = specsOf(studio)[0].id;
    // An id no spec has is said back to Maintainer.
    studio.add(MAINTAINER, line("bot", "again"));
    await desk.componentSpec(MAINTAINER, "00000000-0000-4000-8000-000000000000", "{}");
    expect(studio.notes.at(-1)).toEqual([MAINTAINER, "(App: No component spec has the id 00000000-0000-4000-8000-000000000000; nothing changed.)"]);
    // Only Maintainer's tag counts.
    await desk.componentSpec(MAIN, id, JSON.stringify({ name: "stolen" }));
    expect(specsOf(studio)[0].name).toBe("disk-usage");
    expect(studio.handed).toEqual([]);
  });

  it("a suggestion for a component the library already has goes on the bot's list on press (only the bots are left), and Maintainer is never asked", async () => {
    const { studio, desk, chips } = deskOver();
    studio.component("disk", "Disk card.\nData: {\"used\": 1}");
    studio.chatsById.get(MAIN)!.components = [];
    const record = reply(studio, "Here.");
    await desk.suggest("disk", "how full the disk is, from df -h", MAIN);
    expect(chips(MAIN, record.id)[0]).toMatchObject({ name: "disk", status: "draft", suggested: true });
    await desk.press(specsOf(studio)[0].id);
    expect(chips(MAIN, record.id)[0]).toMatchObject({ name: "disk", status: "done", undo: "undo" });
    expect(studio.chatsById.get(MAIN)!.components).toContain("disk");
    expect(studio.handed).toEqual([]);
  });

  it("a one-shot suggestion gets no chip, and at most one per turn", async () => {
    const { studio, desk, chips } = deskOver();
    const record = reply(studio, "A table.");
    await desk.suggest("Invoices", "a one-off table of this week's invoices", MAIN);
    expect(chips(MAIN, record.id)).toEqual([]);
    await desk.suggest("Invoices", "how many invoices are open, from the billing command", MAIN);
    expect(chips(MAIN, record.id)).toHaveLength(1);
    // The same reply gets no second chip.
    await desk.suggest("Open Invoices", "how many are open, from the billing command", MAIN);
    expect(chips(MAIN, record.id)).toHaveLength(1);
    studio.add(MAIN, line("bot", "And more."));
    await desk.suggest("Late Invoices", "which invoices are late, from the billing command", MAIN);
    expect(chips(MAIN)).toHaveLength(1);
  });
});

describe("anti-nag rules and Undo/Restore (ADR-006 M4)", () => {
  it("a suggestion for a component the bot lacks offers the library's; Build puts it on the list without Maintainer; Undo takes it off and Restore puts it back", async () => {
    const { studio, desk, chips } = deskOver();
    studio.component("disk-usage", "Shows how full the disk is.\n");
    const record = reply(studio, "Disk is 80% full.");
    await desk.suggest("disk-usage", "how full the disk is, from df -h", MAIN);
    const chip = chips(MAIN, record.id)[0]!;
    expect(chip).toMatchObject({ name: "disk-usage", status: "draft", suggested: true });
    await desk.press(chip.id);
    const done = chips(MAIN, record.id)[0]!;
    expect(done.status).toBe("done");
    expect(done.undo).toBe("undo");
    expect(studio.chatsById.get(MAIN)!.components).toContain("disk-usage");
    expect(studio.handed).toEqual([]);

    await desk.undo(chip.id);
    expect(chips(MAIN, record.id)[0]!.undo).toBe("restore");
    expect(chips(MAIN, record.id)[0]!.component ?? null).toBeNull();
    expect(studio.chatsById.get(MAIN)!.components).not.toContain("disk-usage");
    expect(studio.components.has("disk-usage")).toBe(true);
    expect(studio.notices.at(-1)).toEqual([MAIN, "disk-usage taken off Main bot's list. Restore puts it back."]);

    // What the user took back is not suggested again.
    studio.add(MAIN, line("user", "again?"));
    const later = studio.add(MAIN, line("bot", "Disk again."));
    await desk.suggest("disk-usage", "how full the disk is, from df -h", MAIN);
    expect(chips(MAIN, later.id)).toEqual([]);

    await desk.restore(chip.id);
    expect(chips(MAIN, record.id)[0]!.undo).toBe("undo");
    expect(studio.chatsById.get(MAIN)!.components).toContain("disk-usage");
    expect(studio.notices.at(-1)).toEqual([MAIN, "disk-usage restored to Main bot."]);
  });

  it("Restore says so when the library no longer has it", async () => {
    const { studio, desk, chips } = deskOver();
    studio.component("disk-usage", "Shows how full the disk is.\n");
    const record = reply(studio, "Disk is 80% full.");
    await desk.suggest("disk-usage", "how full the disk is, from df -h", MAIN);
    const id = chips(MAIN, record.id)[0]!.id;
    await desk.press(id);
    await desk.undo(id);
    studio.components.delete("disk-usage");
    await desk.restore(id);
    expect(studio.notices.at(-1)).toEqual([MAIN, "Couldn't restore disk-usage: it is no longer in the library."]);
  });
});

describe("a built component's command is allowed only on the app page's ApprovalSheet", () => {
  it("the built card's command asks for the command and its Detail command, and runs the one the card showed", async () => {
    const { studio, desk } = deskOver();
    const record = reply(studio, "Disk is 80% full.");
    const id = await suggested(studio, desk, record, "Disk Usage", "how full the disk is, from df -h");
    await desk.press(id);
    // Maintainer builds it with the command the reply's work ran; the library copy has it (and a Detail command) in its about.md.
    await maintainerSays(studio, desk, id, { name: "disk-usage", about: "Shows how full the disk is", command: "df -h" }, "Built disk-usage.");
    studio.component("disk-usage", "Shows how full the disk is.\nCommand: df -h\nDetail command: du -sh {path}\n");
    await desk.finishBuilds();
    const folder = specsOf(studio)[0].folder;
    expect(await desk.runComponent(id, { command: "df -h", folder })).toEqual({ accepted: false, needsApproval: { command: "df -h", folder, detail: "du -sh {path}", card: "disk-usage" } });
    expect(await desk.runComponent(id, { command: "other", folder })).toEqual({ accepted: false });
    studio.approved.add(`${folder}\ndf -h`);
    studio.approved.add(`${folder}\nDetail command: du -sh {path}`);
    expect(await desk.runComponent(id, { command: "df -h", folder, force: true })).toEqual({ accepted: true });
    await desk.run(async () => {});
    expect(studio.runs).toEqual([{ card: `spec/${id}`, command: "df -h", folder, force: true }]);
  });
});

describe("what a restart and the core's own writes do", () => {
  it("reads every chat's specs when it starts, in 1.x's format, and draws their chips", async () => {
    const { studio, desk, chips } = deskOver();
    const record = reply(studio, "Disk is 80% full.");
    await desk.suggest("Disk Usage", "how full the disk is, from df -h", MAIN);
    const saved = structuredClone(studio.stored);
    // A new desk (the plugin host restarted) over what was kept.
    const again = deskOver(studio);
    await again.desk.load();
    expect(again.chips(MAIN, record.id)).toEqual([expect.objectContaining({ name: "disk-usage", status: "draft", suggested: true })]);
    expect(studio.stored).toEqual(saved);
    void desk; void chips;
  });

  it("a spec the core cannot read is left out, as 1.x's decoder would for a whole file", async () => {
    const { studio, desk } = deskOver();
    studio.stored[MAIN] = [{ id: "not-a-spec" }, { nope: true }];
    await desk.load();
    expect(specsOf(studio)).toEqual([{ id: "not-a-spec" }, { nope: true }]);
    expect(desk.locate("NOT-A-SPEC")).toBeNull();
  });

  it("a fill that fails is said in the spec, and a bot that stays busy too", async () => {
    const { studio, desk } = deskOver();
    const record = reply(studio, TESTS);
    const id = await suggested(studio, desk, record);
    await desk.press(id);
    studio.answer = { kind: "busy" } as never;
    await maintainerSays(studio, desk, id, { name: "test-board" }, "Built.");
    studio.component("test-board", "Tests.\n");
    await desk.finishBuilds();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await desk.run(async () => {});
    expect(specsOf(studio)[0]).toMatchObject({ fillError: "it stayed busy" });
    expect(specsOf(studio)[0].conversation.at(-1)).toEqual({ kind: "event", text: "Main bot did not fill it: it stayed busy" });
    expect(FILL_TIMING.answer).toBeGreaterThan(0);
  });
});
