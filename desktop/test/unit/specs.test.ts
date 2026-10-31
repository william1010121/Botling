// Component specs through the core (Phase 5a; 1.x's Workspace+Specs.swift): "Make into component" on a
// reply hands Maintainer the first build; its <component-spec> fills the spec; the component landing in
// the library goes on the bot's list and the bot that wrote the reply draws it under that reply; a bot's
// <suggest-component> is only a chip until pressed; the spec panel's words, edits, Build it and Cancel.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

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

describe("component specs (Workspace+Specs.swift)", () => {
  it("Make into component hands the reply straight to Maintainer: no copy of the writer's session is started", async () => {
    const dir = tempDir("specs-direct");
    const c = core(dir, { FAKE_CLAUDE_LOG: join(dir, "start.log") });
    await say(c, MAIN, "/say Your 3 tests: 2 passed, 1 failed.");
    const line = await reply(c, "Your 3 tests: 2 passed, 1 failed.");
    const { specId } = await c.call({ type: "spec.make", botId: MAIN, messageId: line.id });
    const relay = await until(async () => (await c.chat(MAINTAINER)).messages.find((m: any) => m.role === "relay"), { timeout: 10_000, what: "the request" });
    expect(relay.text).toContain(`(Component spec ${specId}; action: build-first)`);
    expect(relay.text).not.toContain("brief for you");
    const spec = JSON.parse(readFileSync(join(dir, "main", "specs.json"), "utf8"))[0];
    expect(spec.brief).toBeUndefined();
    expect(spec.conversation).toEqual([{ kind: "event", text: "Sent to Maintainer to build the first version" }]);
    expect(lines(join(dir, "start.log")).filter((start) => start.args.includes("--fork-session"))).toHaveLength(0);
    expect((await c.chat()).messages.filter((m: any) => m.role === "bot").map((m: any) => m.text)).toEqual(["Your 3 tests: 2 passed, 1 failed."]);
  });

  it("Make into component: Maintainer builds the first version; it lands, goes on the bot's list, and the bot draws it under its reply", async () => {
    const dir = tempDir("specs");
    const c = core(dir);
    await say(c, MAIN, "/say Your 3 tests: 2 passed, 1 failed.");
    const line = await reply(c, "Your 3 tests: 2 passed, 1 failed.");
    const { specId } = await c.call({ type: "spec.make", botId: MAIN, messageId: line.id, purpose: "see the tests at a glance" });
    expect(specId).toMatch(/^[0-9A-F-]{36}$/);
    // The chip says Building…; specs.json is 1.x's.
    const chip = await until(async () => (await c.chat()).messages.find((m: any) => m.id === line.id)?.specs?.[0]);
    expect(chip).toMatchObject({ id: specId, name: "your-tests", status: "building", suggested: false, open: false, component: null });
    const saved = JSON.parse(readFileSync(join(dir, "main", "specs.json"), "utf8"));
    expect(saved[0]).toMatchObject({ id: specId, messageID: line.id, name: "your-tests", status: "building", asked: true, bots: ["Main bot"], purpose: "see the tests at a glance",
      samples: [{ label: "This reply", kind: "reply", data: JSON.stringify({ text: "Your 3 tests: 2 passed, 1 failed." }) }],
      conversation: [{ kind: "event", text: "Sent to Maintainer to build the first version" }] });
    // Maintainer got the first build, 1.x's words.
    const relay = await until(async () => (await c.chat(MAINTAINER)).messages.find((m: any) => m.role === "relay"));
    expect(relay.text).toContain(`(Component spec ${specId}; action: build-first) Build the first version now. What it is for, in the user's words: see the tests at a glance\nThe user wants it built right away from Main bot's reply, given here as context. The reply:\nYour 3 tests: 2 passed, 1 failed.\nThe user's own message that led to the reply (verbatim):\n/say Your 3 tests: 2 passed, 1 failed.\nThe app's first draft:\n- name: your-tests`);
    // Its answer names what it built; the component lands in the library.
    await until(async () => !(await c.chat(MAINTAINER)).running);
    await say(c, MAINTAINER, `/say Built test-board. <component-spec id="${specId}">{"name": "test-board", "about": "Tests at a glance", "fields": [{"name": "passed", "type": "int"}]}</component-spec>`);
    component(dir, "test-board", "Tests at a glance.\nData: {\"passed\": 2}");
    const done = await until(async () => { const found = (await c.chat()).messages.find((m: any) => m.id === line.id)?.specs?.[0]; return found?.status === "done" && found.display ? found : null; }, { timeout: 10_000, what: "the built component under the reply" });
    expect(done).toMatchObject({ name: "test-board", component: "test-board", filling: null });
    expect(done.display).toMatchObject({ name: "test-board", data: '{"filled":true}' });
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).components).toContain("test-board");
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "notice" && m.text === "test-board added to Main bot."));
    // The bot that wrote the reply was asked to draw it, quietly (no line of its own for that turn).
    expect(texts(dir).some((text) => text.startsWith(`(App: Draw the component "test-board" for your reply from `) && text.includes(`("Your 3 tests: 2 passed, 1 failed."): the user made that reply into this component, for this: see the tests at a glance.`))).toBe(true);
    const spec = JSON.parse(readFileSync(join(dir, "main", "specs.json"), "utf8"))[0];
    expect(spec).toMatchObject({ status: "done", built: "test-board", version: 1, filledBy: "Main bot", filled: '{"filled":true}', about: "Tests at a glance" });
    expect(spec.conversation.map((line: any) => line.text)).toEqual([
      "Sent to Maintainer to build the first version", "Built test-board.", "test-board added to Main bot", "Asked Main bot to fill it from its reply", "Filled by Main bot",
    ]);
    expect((await c.chat()).messages.filter((m: any) => m.role === "bot").map((m: any) => m.text)).toEqual(["Your 3 tests: 2 passed, 1 failed."]);

    // Its spec in the right panel ("Edit spec"): words there are a change, built as v2 right away.
    await c.call({ type: "spec.act", specId, action: { kind: "open" } });
    const opened = await until(() => c.of("spec.updated").map((e: any) => e.event.spec).findLast((view: any) => view?.id === specId));
    expect(opened).toMatchObject({ name: "test-board", status: "done", version: 1, chat: "Main bot", preview: "test-board", steps: [
      { label: "Sent to Maintainer", state: "done" }, { label: "Built into the library", state: "done" }, { label: "Add to Main bot", state: "done" }, { label: "Filled by Main bot", state: "done" },
    ] });
    expect(opened.from).toMatch(/^from Main bot's reply at /);
    expect((await c.call({ type: "chat.snapshot" })).spec.id).toBe(specId);
    await until(async () => !(await c.chat(MAINTAINER)).running);
    await c.call({ type: "spec.act", specId, action: { kind: "say", text: "make it green", request: "r1" } });
    const change = await until(async () => (await c.chat(MAINTAINER)).messages.filter((m: any) => m.role === "relay").find((m: any) => m.text.includes("action: change")));
    expect(change.text).toContain(`(Component spec ${specId}; action: change) Change it now: build v2 of the component "test-board" with this change, right away.\nThe user asks: make it green`);
    const working = await until(() => c.of("spec.updated").map((e: any) => e.event.spec).findLast((view: any) => view?.change?.state === "working"));
    expect(working.change).toMatchObject({ version: 2, request: "r1" });
    // Its turn ended without a new version: said in the panel.
    await until(async () => !(await c.chat(MAINTAINER)).running);
    const failed = await until(() => c.of("spec.updated").map((e: any) => e.event.spec).findLast((view: any) => view?.change?.state === "failed"));
    expect(failed.change.error).toBe("Maintainer's turn ended without a new version: On it.");
    await c.call({ type: "spec.close" });
    await until(() => (c.of("spec.updated").at(-1)?.event as any)?.spec === null);
  });

  it("<suggest-component> is a chip only; pressed, its first version is built; the panel's draft words and Cancel", async () => {
    const dir = tempDir("specs");
    const c = core(dir);
    await say(c, MAIN, `/say Disk is 80% full. <suggest-component name="Disk Usage">how full the disk is, from df -h</suggest-component>`);
    const line = await reply(c, "Disk is 80% full.");
    const chip = await until(async () => (await c.chat()).messages.find((m: any) => m.id === line.id)?.specs?.[0]);
    expect(chip).toMatchObject({ name: "disk-usage", status: "draft", suggested: true });
    // Nothing went to Maintainer.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await c.chat(MAINTAINER)).messages.some((m: any) => m.role === "relay")).toBe(false);
    // Opened before it was pressed (a draft): Maintainer is asked to shape it, not build it.
    await c.call({ type: "spec.act", specId: chip.id, action: { kind: "open" } });
    const shaping = await until(async () => (await c.chat(MAINTAINER)).messages.find((m: any) => m.role === "relay"));
    expect(shaping.text).toContain(`(Component spec ${chip.id}; action: shape) What it is for, in Main bot's words: how full the disk is, from df -h`);
    // An edit in the panel goes with the next words.
    await c.call({ type: "spec.act", specId: chip.id, action: { kind: "edit", key: "refresh", value: "shown" } });
    await until(async () => !(await c.chat(MAINTAINER)).running);
    await c.call({ type: "spec.act", specId: chip.id, action: { kind: "say", text: "add the free space too" } });
    const said = await until(async () => (await c.chat(MAINTAINER)).messages.filter((m: any) => m.role === "relay")[1]);
    expect(said.text).toContain(`(Component spec ${chip.id}; action: shape) The user says: add the free space too\nTheir edits: Refresh: shown\nThe spec now:`);
    // Maintainer's update with a question shows in the panel.
    await until(async () => !(await c.chat(MAINTAINER)).running);
    await say(c, MAINTAINER, `/say Two things. <component-spec id="${chip.id}">{"fields": ["used: num", "free: num"], "questions": [{"key": "refresh", "text": "How often?", "options": [{"label": "When shown", "value": "shown"}, {"label": "Every 5 min", "value": "interval"}], "suggested": 1}]}</component-spec>`);
    const asked = await until(() => c.of("spec.updated").map((e: any) => e.event.spec).findLast((view: any) => view?.questions?.length));
    expect(asked).toMatchObject({ fields: [{ name: "used", type: "num", by: "maintainer" }, { name: "free", type: "num", by: "maintainer" }], origins: { refresh: "user", fields: "maintainer" },
      questions: [{ id: "q1", text: "How often?", options: [{ label: "When shown" }, { label: "Every 5 min" }], suggested: 1 }] });
    expect(asked.conversation.at(-1)).toEqual({ kind: "maintainer", text: "Two things." });
    // An id no spec has is said back to Maintainer.
    await say(c, MAINTAINER, `/say <component-spec id="00000000-0000-4000-8000-000000000000">{}</component-spec>`);
    // Cancel: the chip goes, the panel closes.
    await c.call({ type: "spec.act", specId: chip.id, action: { kind: "cancel" } });
    await until(async () => !(await c.chat()).messages.find((m: any) => m.id === line.id)?.specs);
    await until(() => (c.of("spec.updated").at(-1)?.event as any)?.spec === null);
    expect(JSON.parse(readFileSync(join(dir, "main", "specs.json"), "utf8"))).toEqual([]);
    // A reply that already is a library component opens its spec at once (only the bots are left).
    component(dir, "disk", "Disk card.\nData: {\"used\": 1}");
    await until(async () => !!(await c.call({ type: "chat.snapshot" })).components.disk);
    await say(c, MAIN, `/say Here. <show name="disk">{"used": 80}</show>`);
    const shown = await reply(c, "Here.");
    expect(shown.component).toBe("disk");
    const made = await c.call({ type: "spec.make", botId: MAIN, messageId: shown.id });
    const existing = await until(() => c.of("spec.updated").map((e: any) => e.event.spec).findLast((view: any) => view?.id === made.specId));
    expect(existing).toMatchObject({ existing: "disk", status: "draft", preview: "disk", fields: [{ name: "used", type: "int", by: "app" }] });
  });
});

describe("result pages (Phase 5c, 1.x's PagePreview and makeComponent(from:preview:))", () => {
  it("a reply's links to result pages are preview cards under it; Make into component on one makes a spec from that page", async () => {
    const dir = tempDir("specs-pages");
    const c = core(dir);
    const artifacts = join(dir, "work", ".bot", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "report.html"), "<!doctype html><h1>Sales</h1><ul><li>North 12</li><li>South 9</li></ul>");
    writeFileSync(join(artifacts, "other.html"), "<p>Other</p>");
    await say(c, MAIN, `/say Done: [Sales report](file://${artifacts}/report.html) and [other](file://${artifacts}/other.html), not [this](file://${dir}/x.html).`);
    const line = await until(async () => (await c.chat()).messages.findLast((m: any) => m.role === "bot"));
    expect(line.previews).toHaveLength(2);
    const card = JSON.parse(line.previews[0].data);
    expect(line.previews[0].name).toBe("網頁預覽卡片");
    expect(card).toMatchObject({ path: join(artifacts, "report.html"), title: "Sales report", name: "report.html", missing: false, url: `file://${artifacts}/report.html` });
    expect(card.src).toMatch(new RegExp(`^botling-card://preview${artifacts.replaceAll("/", "\\/").replaceAll(".", "\\.")}/report\\.html\\?v=\\d+$`));
    // The app's own card is in the library (seeded as 1.x does).
    expect((await c.call({ type: "chat.snapshot" })).components["網頁預覽卡片"]).toBeTruthy();
    const { specId } = await c.call({ type: "spec.make", botId: MAIN, messageId: line.id, preview: 0 });
    const spec = JSON.parse(readFileSync(join(dir, "main", "specs.json"), "utf8")).find((entry: any) => entry.id === specId);
    expect(spec).toMatchObject({ name: "report", page: join(artifacts, "report.html"), shownAs: "網頁預覽卡片", samples: [{ label: "This page", kind: "page" }] });
    // Maintainer gets the page's own words with the request.
    const relay = await until(async () => (await c.chat(MAINTAINER)).messages.find((m: any) => m.role === "relay" && m.text.includes(specId)));
    expect(relay.text).toContain(`${join(artifacts, "report.html")}`);
    expect(relay.text).toMatch(/says:\nSales\n+- North 12\n+- South 9/);
    // Pressed again: the same spec. The reply itself: a spec of its own. A card that is not there: nothing.
    expect((await c.call({ type: "spec.make", botId: MAIN, messageId: line.id, preview: 0 })).specId).toBe(specId);
    expect((await c.call({ type: "spec.make", botId: MAIN, messageId: line.id, preview: 2 })).specId).toBeNull();
    const second = await c.call({ type: "spec.make", botId: MAIN, messageId: line.id, preview: 1 });
    expect(second.specId).not.toBe(specId);
    const saved = JSON.parse(readFileSync(join(dir, "main", "specs.json"), "utf8"));
    expect(saved.find((entry: any) => entry.id === second.specId)).toMatchObject({ name: "other", page: join(artifacts, "other.html") });
    const relay2 = await until(async () => (await c.chat(MAINTAINER)).messages.find((m: any) => m.role === "relay" && m.text.includes(second.specId)));
    expect(relay2.text).toContain(`The result page it links, ${join(artifacts, "other.html")}, says:\nOther`);
    const reply = await c.call({ type: "spec.make", botId: MAIN, messageId: line.id });
    expect(reply.specId).not.toBe(specId);
    expect(reply.specId).not.toBe(second.specId);
  });
});
