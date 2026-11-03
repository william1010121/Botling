// The component studio's desk (desk.ts) over a studio seam in memory (fake-studio.ts): the scenarios the core's specs.test.ts ran through a
// whole core, now through the plugin's own state machine. A step is one await: `desk.make(...)` returns when everything it did is written.
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
/** Maintainer's reply and the tag in it, as the host hands them over. */
async function maintainerSays(studio: FakeStudio, desk: ReturnType<typeof deskOver>["desk"], id: string, json: unknown, words: string) {
  studio.add(MAINTAINER, line("bot", words));
  await desk.componentSpec(MAINTAINER, id, JSON.stringify(json));
}

describe("Make into component", () => {
  it("hands the reply straight to Maintainer as the first build, and the chip says Building…", async () => {
    const { studio, desk, chips } = deskOver();
    const record = reply(studio, TESTS);
    const made = await desk.make(MAIN, record.id, "see the tests at a glance");
    expect(made?.id).toMatch(UUID);
    expect(studio.handed).toHaveLength(1);
    expect(studio.handed[0]).toContain(`(Component spec ${made!.id}; action: build-first) Build the first version now. What it is for, in the user's words: see the tests at a glance`);
    expect(studio.handed[0]).not.toContain("brief for you");
    const saved = specsOf(studio)[0];
    expect(saved).toMatchObject({
      id: made!.id, messageID: record.id, name: "your-tests", status: "building", asked: true, bots: ["Main bot"], purpose: "see the tests at a glance",
      samples: [{ label: "This reply", kind: "reply", data: JSON.stringify({ text: TESTS }) }],
      conversation: [{ kind: "event", text: "Sent to Maintainer to build the first version" }],
    });
    expect(saved.brief).toBeUndefined();
    expect(studio.working_).toContainEqual(["your-tests", "built from a reply"]);
    expect(chips(MAIN, record.id)).toEqual([expect.objectContaining({ id: made!.id, name: "your-tests", status: "building", suggested: false, open: false, component: null })]);
    // Pressed again: the same spec, nothing more is sent.
    expect((await desk.make(MAIN, record.id, null))?.id).toBe(made!.id);
    expect(studio.handed).toHaveLength(1);
  });

  it("builds the first version: it lands, goes on the bot's list, and the bot that wrote the reply draws it under its reply", async () => {
    const { studio, desk, chips, states } = deskOver();
    const record = reply(studio, TESTS);
    const made = (await desk.make(MAIN, record.id, "see the tests at a glance"))!;
    await maintainerSays(studio, desk, made.id, { name: "test-board", about: "Tests at a glance", fields: [{ name: "passed", type: "int" }] }, "Built test-board.");
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
    expect(studio.asks[0]!.text).toContain(`("${TESTS}"): the user made that reply into this component, for this: see the tests at a glance.`);
    const spec = specsOf(studio)[0];
    expect(spec).toMatchObject({ status: "done", built: "test-board", version: 1, filledBy: "Main bot", filled: '{"filled":true}', about: "Tests at a glance" });
    expect(spec.conversation.map((entry: any) => entry.text)).toEqual([
      "Sent to Maintainer to build the first version", "Built test-board.", "test-board added to Main bot", "Asked Main bot to fill it from its reply", "Filled by Main bot",
    ]);
    const chip = chips(MAIN, record.id)[0]!;
    expect(chip).toMatchObject({ name: "test-board", status: "done", component: "test-board", filling: null, undo: "undo" });
    expect(chip.display).toMatchObject({ name: "test-board", data: '{"filled":true}' });
    // Its spec in the right panel ("Edit spec").
    expect(await desk.openSpec(made.id)).toEqual({ accepted: true });
    const opened = states.findLast((entry) => entry.state?.id === made.id)!.state!;
    expect(opened).toMatchObject({ name: "test-board", status: "done", version: 1, chat: "Main bot", preview: "test-board", steps: [
      { label: "Sent to Maintainer", state: "done" }, { label: "Built into the library", state: "done" }, { label: "Add to Main bot", state: "done" }, { label: "Filled by Main bot", state: "done" },
    ] });
    expect(opened.from).toMatch(/^from Main bot's reply at /);
    expect(await desk.state()).toMatchObject({ chat: MAIN, state: { id: made.id } });
    // Words there are a change, built as v2 right away.
    await desk.say(made.id, "make it green", "r1");
    expect(studio.handed.at(-1)).toContain(`(Component spec ${made.id}; action: change) Change it now: build v2 of the component "test-board" with this change, right away.\nThe user asks: make it green`);
    expect(states.findLast((entry) => entry.state?.change?.state === "working")!.state!.change).toMatchObject({ version: 2, request: "r1" });
    // Its turn ended without a new version: said in the panel.
    await desk.settleChanges({ role: "bot", text: "On it." }, false);
    expect(states.findLast((entry) => entry.state?.change?.state === "failed")!.state!.change!.error).toBe("Maintainer's turn ended without a new version: On it.");
    await desk.closePanel();
    expect(states.at(-1)).toEqual({ chat: MAIN, state: null });
  });
});

describe("<suggest-component>", () => {
  it("is a chip only; opened, Maintainer shapes it; edits and words go along; its questions show; Cancel takes it away", async () => {
    const { studio, desk, chips, takeovers, states } = deskOver();
    const record = reply(studio, "Disk is 80% full.");
    await desk.suggest("Disk Usage", "how full the disk is, from df -h", MAIN);
    expect(chips(MAIN, record.id)).toEqual([expect.objectContaining({ name: "disk-usage", status: "draft", suggested: true })]);
    expect(studio.handed).toEqual([]);
    const id = specsOf(studio)[0].id;
    // Opened before it was pressed (a draft): Maintainer is asked to shape it, not build it.
    await desk.openSpec(id);
    expect(takeovers.at(-1)).toEqual({ chat: MAIN, wide: false });
    expect(studio.handed[0]).toContain(`(Component spec ${id}; action: shape) What it is for, in Main bot's words: how full the disk is, from df -h`);
    await desk.editValue(id, "refresh", "shown");
    await desk.say(id, "add the free space too", null);
    expect(studio.handed[1]).toContain(`(Component spec ${id}; action: shape) The user says: add the free space too\nTheir edits: Refresh: shown\nThe spec now:`);
    await maintainerSays(studio, desk, id, { fields: ["used: num", "free: num"], questions: [{ key: "refresh", text: "How often?", options: [{ label: "When shown", value: "shown" }, { label: "Every 5 min", value: "interval" }], suggested: 1 }] }, "Two things.");
    const asked = states.findLast((entry) => entry.state?.questions.length)!.state!;
    expect(asked).toMatchObject({
      fields: [{ name: "used", type: "num", by: "maintainer" }, { name: "free", type: "num", by: "maintainer" }], origins: { refresh: "user", fields: "maintainer" },
      questions: [{ id: "q1", text: "How often?", options: [{ label: "When shown" }, { label: "Every 5 min" }], suggested: 1 }],
    });
    expect(asked.conversation.at(-1)).toEqual({ kind: "maintainer", text: "Two things." });
    // An id no spec has is said back to Maintainer.
    studio.add(MAINTAINER, line("bot", "again"));
    await desk.componentSpec(MAINTAINER, "00000000-0000-4000-8000-000000000000", "{}");
    expect(studio.notes.at(-1)).toEqual([MAINTAINER, "(App: No component spec has the id 00000000-0000-4000-8000-000000000000; nothing changed.)"]);
    // Only Maintainer's tag counts.
    await desk.componentSpec(MAIN, id, JSON.stringify({ name: "stolen" }));
    expect(specsOf(studio)[0].name).toBe("disk-usage");
    // Cancel: the chip goes, the panel closes.
    await desk.cancel(id);
    expect(chips(MAIN)).toEqual([]);
    expect(specsOf(studio)).toEqual([]);
    expect(takeovers.at(-1)).toEqual({ chat: null, wide: false });
    expect(states.at(-1)).toEqual({ chat: MAIN, state: null });
  });

  it("a reply that already is a library component opens its spec at once (only the bots are left)", async () => {
    const { studio, desk, states, takeovers } = deskOver();
    studio.component("disk", "Disk card.\nData: {\"used\": 1}");
    const record = reply(studio, "Here.", { displays: [{ name: "disk", data: '{"used": 80}' }] });
    const made = (await desk.make(MAIN, record.id, null))!;
    expect(takeovers.at(-1)).toEqual({ chat: MAIN, wide: false });
    expect(states.findLast((entry) => entry.state?.id === made.id)!.state).toMatchObject({ existing: "disk", status: "draft", preview: "disk", fields: [{ name: "used", type: "int", by: "app" }] });
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
    await desk.build(chip.id);
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
    await desk.build(id);
    await desk.undo(id);
    studio.components.delete("disk-usage");
    await desk.restore(id);
    expect(studio.notices.at(-1)).toEqual([MAIN, "Couldn't restore disk-usage: it is no longer in the library."]);
  });
});

describe("a spec's test run is allowed only on the app page's ApprovalSheet", () => {
  it("Test run answers what the sheet asks; a different command or folder is not accepted; once allowed it runs and keeps the output", async () => {
    const { studio, desk } = deskOver();
    const record = reply(studio, "Disk is 80% full.");
    await desk.suggest("Disk Usage", "how full the disk is", MAIN);
    const id = specsOf(studio)[0].id;
    const command = `printf '{"used": 80}'`;
    studio.outputs.set(command, `{"used": 80}`);
    await desk.editValue(id, "command", command);
    const folder = specsOf(studio)[0].folder;
    expect(specsOf(studio)[0].command).toBe(command);
    expect(await desk.testRun(id, command, folder)).toEqual({ accepted: false, needsApproval: { command, folder, detail: null, card: "disk-usage" } });
    expect(studio.runs).toEqual([]);
    expect(await desk.testRun(id, "rm -rf /tmp/x", folder)).toEqual({ accepted: false });
    expect(await desk.testRun(id, command, "/tmp")).toEqual({ accepted: false });
    // The user allowed it on the sheet (the core records that), and the panel asks again.
    studio.approved.add(`${folder}\n${command}`);
    expect(await desk.testRun(id, command, folder)).toEqual({ accepted: true });
    await desk.run(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    await desk.run(async () => {});
    expect(studio.runs).toEqual([{ card: `spec/${id}`, command, folder, force: true }]);
    const spec = specsOf(studio)[0];
    expect(spec.testRun).toMatchObject({ command, folder, output: `{"used": 80}` });
    expect(spec.samples.find((sample: any) => sample.kind === "testRun")).toMatchObject({ data: `{"used": 80}` });
    void record;
  });

  it("the built card's command asks for the command and its Detail command, and runs the one the card showed", async () => {
    const { studio, desk } = deskOver();
    const record = reply(studio, "Disk is 80% full.");
    studio.component("disk-usage", "Shows how full the disk is.\nCommand: df -h\nDetail command: du -sh {path}\n");
    await desk.suggest("disk-usage", "how full the disk is, from df -h", MAIN);
    const id = specsOf(studio)[0].id;
    await desk.editValue(id, "command", "df -h");
    await desk.build(id);
    const folder = specsOf(studio)[0].folder;
    expect(await desk.runComponent(id, { command: "df -h", folder })).toEqual({ accepted: false, needsApproval: { command: "df -h", folder, detail: "du -sh {path}", card: "disk-usage" } });
    expect(await desk.runComponent(id, { command: "other", folder })).toEqual({ accepted: false });
    studio.approved.add(`${folder}\ndf -h`);
    studio.approved.add(`${folder}\nDetail command: du -sh {path}`);
    expect(await desk.runComponent(id, { command: "df -h", folder, force: true })).toEqual({ accepted: true });
    await desk.run(async () => {});
    expect(studio.runs).toEqual([{ card: `spec/${id}`, command: "df -h", folder, force: true }]);
    void record;
  });
});

describe("result pages (Phase 5c)", () => {
  it("Make into component on a result page's preview card makes a spec from that page", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const base = join(tmpdir(), `studio-pages-${process.pid}-${Date.now()}`);
    const artifacts = join(base, "work", ".bot", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "report.html"), "<!doctype html><h1>Sales</h1><ul><li>North 12</li><li>South 9</li></ul>");
    writeFileSync(join(artifacts, "other.html"), "<p>Other</p>");
    const { studio, desk } = deskOver();
    studio.component("網頁預覽卡片", "Page preview.\n");
    const record = reply(studio, `Done: [Sales report](file://${artifacts}/report.html) and [other](file://${artifacts}/other.html).`);
    const card = (path: string) => JSON.stringify({ path, title: path, name: path, missing: false, url: `file://${path}` });
    studio.previewsOf.set(record.id, [card(join(artifacts, "report.html")), card(join(artifacts, "other.html"))]);
    const first = (await desk.make(MAIN, record.id, null, 0))!;
    expect(specsOf(studio).find((entry) => entry.id === first.id)).toMatchObject({ name: "report", page: join(artifacts, "report.html"), shownAs: "網頁預覽卡片", samples: [{ label: "This page", kind: "page" }] });
    expect(studio.handed.at(-1)).toContain(join(artifacts, "report.html"));
    expect(studio.handed.at(-1)).toMatch(/says:\nSales\n+- North 12\n+- South 9/);
    // Pressed again: the same spec. The reply itself: a spec of its own. A card that is not there: nothing.
    expect((await desk.make(MAIN, record.id, null, 0))!.id).toBe(first.id);
    expect(await desk.make(MAIN, record.id, null, 2)).toBeNull();
    const second = (await desk.make(MAIN, record.id, null, 1))!;
    expect(second.id).not.toBe(first.id);
    expect(specsOf(studio).find((entry) => entry.id === second.id)).toMatchObject({ name: "other", page: join(artifacts, "other.html") });
    expect(studio.handed.at(-1)).toContain(`The result page it links, ${join(artifacts, "other.html")}, says:\nOther`);
    const whole = (await desk.make(MAIN, record.id, null))!;
    expect([first.id, second.id]).not.toContain(whole.id);
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
    expect(await desk.state()).toBeNull();
    expect(desk.locate("NOT-A-SPEC")).toBeNull();
  });

  it("a fill that fails is said in the spec, and a bot that stays busy too", async () => {
    const { studio, desk } = deskOver();
    const record = reply(studio, TESTS);
    const made = (await desk.make(MAIN, record.id, null))!;
    studio.answer = { kind: "busy" } as never;
    await maintainerSays(studio, desk, made.id, { name: "test-board" }, "Built.");
    studio.component("test-board", "Tests.\n");
    await desk.finishBuilds();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await desk.run(async () => {});
    expect(specsOf(studio)[0]).toMatchObject({ fillError: "it stayed busy" });
    expect(specsOf(studio)[0].conversation.at(-1)).toEqual({ kind: "event", text: "Main bot did not fill it: it stayed busy" });
    expect(FILL_TIMING.answer).toBeGreaterThan(0);
  });
});
