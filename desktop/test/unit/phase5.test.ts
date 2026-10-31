// Phase 5a: the strings the rest of Maintainer's component work and the completion checks give the
// bots, equal character for character to what the Swift app wrote (test/fixtures/phase5-golden.json,
// made by Tests/ClaudeCodeBotCoreTests/DesktopPhase5GoldenExport.swift).
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ComponentLibrary, componentMentions } from "../../src/core/components/library";
import { callInPrompt, transcriptBefore, type Member } from "../../src/core/groups";
import type { ChatRecord } from "../../src/core/store/records";
import { slashLists } from "../../src/renderer/payload";
import { problemReport } from "../../src/core/maintainer";
import type { PinRecord } from "../../src/core/components/pins";
import {
  COMPONENT_ACTIONS, actionHeader, answerOpenQuestions, answerQuestion, boardCommandRequest, buildRequest, changeRequest, draftRequest, draftSpec, editSpecValue,
  fieldsFromJSON, filledData, fillRequest, firstBuildRequest, lastCommand, outputMatches, pageText, parseFields, purposeLine, replyPages, sayRequest, shortTime, slug,
  specSummary, tagNote, updateSpec, type ComponentSpec,
} from "../../src/core/specs";
import { tempDir } from "../helpers";

const golden = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "phase5-golden.json"), "utf8"));

/** The golden run's library: the two built-ins and two components of its own. */
function library(): ComponentLibrary {
  const root = tempDir("phase5-library");
  const parts: [string, string][] = [
    ["test-status", 'Test results: passed and failed counts.\nData: {"passed": 3, "failed": 1}\nCommand: npm test --json'],
    ["test", 'A plain test card.\n\nIt takes {"text": "…"}.'],
    ["choices", "Buttons."],
    ["網頁預覽卡片", "A page."],
  ];
  for (const [name, about] of parts) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "template.html"), `<div>${name}</div>`);
    writeFileSync(join(root, name, "about.md"), about);
  }
  return new ComponentLibrary(() => [root]);
}

describe("the / menu and its mention note (ComponentMentions, mentionNote)", () => {
  const components = library();

  it("reads /names as the Swift app does", () => {
    expect(components.names).toEqual(golden.names);
    for (const { text, names } of golden.mentions) expect([text, componentMentions(text, golden.names)]).toEqual([text, names]);
    for (const { text, note } of golden.mentionNotes) expect(components.mentionNote(text)).toBe(note);
  });

  it("a guest whose newest line names a component is told how to use it", () => {
    const messages: ChatRecord[] = golden.messages;
    const members: Member[] = [{ id: "6A0B0000-0000-4000-8000-000000000002", name: "Main bot" }, { id: golden.shop, name: "Shop" }];
    const speakerName = (id: string) => members.find((m) => m.id === id)?.name ?? null;
    const newest = messages[0]!.id;
    const before = transcriptBefore(newest, messages);
    const mentionNote = (text: string) => components.mentionNote(text);
    expect(callInPrompt({ member: members[1]!, host: "Main bot", chat: messages, transcript: before, newest, ask: null, speakerName, mentionNote })).toBe(golden.callIn);
  });

  it("the menu lists the bot's own components first, the rest of the library after", () => {
    const bot = { components: ["test"] } as Parameters<typeof slashLists>[0];
    expect(slashLists(bot, golden.names)).toEqual({ slashComponents: ["test"], slashLibrary: ["choices", "test-status", "網頁預覽卡片"] });
    expect(slashLists({ ...bot, components: null }, golden.names)).toEqual({ slashComponents: golden.names, slashLibrary: [] });
  });
});

describe("reports and change requests (Workspace+ComponentReport.swift, requestComponentChange)", () => {
  it("a problem report says where the card is, how it refreshes, when its data is from and where its screenshot is", () => {
    process.env.TZ = "UTC";
    for (const { label, pin, report } of golden.more.reports.problems) {
      const record = pin ? { id: "X", name: "test", data: "{}", size: "2x2", makingLive: false, refresh: pin.refresh, minutes: pin.minutes,
        ...(pin.command ? { command: pin.command } : {}), ...(pin.seconds !== null ? { seconds: pin.seconds } : {}),
        ...(pin.ranAt !== null ? { ranAt: pin.ranAt } : {}), ...(pin.savedAt !== null ? { savedAt: pin.savedAt } : {}) } as PinRecord : null;
      expect([label, problemReport("It is cut off", "Shop", record, label === "shown" ? "/tmp/shot one.png" : null)]).toEqual([label, report]);
    }
  });
});

describe("component specs (ComponentSpec.swift): drafts, edits, Maintainer's updates and every request", () => {
  const S = golden.more.specs;
  const components = library();
  const strip = (spec: any) => { const { id: _id, createdAt: _at, ...rest } = spec; return rest; };
  const withoutUndefined = (value: unknown) => JSON.parse(JSON.stringify(value));

  it("the app's first draft from a reply: fields with their types, a sample, the command, a name", () => {
    for (const { label, message, spec } of S.drafts) {
      if (label === "page" || label === "linked") continue;
      const made = draftSpec(message, "Shop", S.folder, components, 0);
      expect([label, strip(withoutUndefined(made))]).toEqual([label, strip(spec)]);
    }
    for (const { label, message, lastCommand: ran } of S.drafts) if (message) expect([label, lastCommand(message)]).toEqual([label, ran]);
    for (const { text, slug: expected } of S.slugs) expect([text, slug(text)]).toEqual([text, expected]);
    for (const { json, fields } of S.jsons) expect([json, fieldsFromJSON(json).map(({ name, type }) => ({ name, type }))]).toEqual([json, fields]);
    for (const { text, fields } of S.parsed) expect([text, parseFields(text).map(({ name, type }) => ({ name, type }))]).toEqual([text, fields]);
    for (const { output, matches } of S.matches) expect([output, outputMatches(output, [{ name: "total", type: "int", by: "app" }, { name: "failures", type: "[…]", by: "app" }])]).toEqual([output, matches]);
  });

  it("the user's edits, Maintainer's <component-spec> and the answers, step by step", () => {
    const spec = draftSpec(S.drafts[1].message, "Shop", S.folder, components, 0);
    spec.purpose = "see the tests at a glance";
    const doing: [string, () => boolean][] = [
      ["edit name", () => editSpecValue("name", "Test Board!", spec)],
      ["edit refresh", () => editSpecValue("refresh", "interval", spec)],
      ["edit minutes", () => editSpecValue("minutes", "5000", spec)],
      ["edit bots", () => editSpecValue("bots", "Shop, main bot, shop,", spec)],
      ["edit reuse", () => editSpecValue("reuse", "yes", spec)],
      ["edit fields", () => editSpecValue("fields", "total: int, failures: [suite, test], extra", spec)],
      ["edit same", () => editSpecValue("about", "", spec)],
      ["update", () => updateSpec(spec, `{"about": "Test results at a glance", "fields": [{"name": "total", "type": "int"}, "passed: int", {"name": ""}], "minutes": 10, "reuse": false, "similar": "test-status", "samples": [{"label": "Failing run", "data": {"total": 0}}, {"label": "Empty", "data": "{}"}], "questions": [{"key": "refresh", "text": "How often?", "options": [{"label": "When shown", "value": "shown"}, "Only by hand"], "suggested": 0}, {"id": "live", "key": "reuse", "text": "Reuse it?", "options": [{"label": "Yes", "value": true}, {"label": "No", "value": false}], "suggested": 5}, {"text": "no options", "options": []}]}`)],
      ["update same", () => updateSpec(spec, `{"about": "Test results at a glance"}`)],
      ["answer", () => answerQuestion("q1", 0, spec)],
      ["answer open", () => { answerOpenQuestions(spec); return true; }],
    ];
    doing.forEach(([what, act], index) => {
      const changed = act();
      expect([what, changed, strip(withoutUndefined(spec))]).toEqual([S.steps[index].what, S.steps[index].changed, strip(S.steps[index].spec)]);
    });
    expect(specSummary(spec)).toBe(S.summary);
  });

  it("what Maintainer is told: the draft, the first build, words, a change, Build it, the Board, the fill", () => {
    const R = S.requests;
    // The ids differ from the Swift run's: they are put back for the check.
    const spec = draftSpec(S.drafts[1].message, "Shop", S.folder, components, 0);
    spec.purpose = "see the tests at a glance";
    Object.assign(spec, structuredClone(S.steps.at(-1).spec));
    const id = spec.id;
    const plain = draftSpec(S.drafts[0].message, "Shop", S.folder, components, 0);
    const swap = (text: string, from: string) => text.replaceAll(from, "ID");
    const built = { ...structuredClone(spec), built: "test-board", version: 2, testRun: { command: "npm test --json", folder: S.folder, output: "x".repeat(700), matches: false } };
    expect(specSummary(built as ComponentSpec)).toBe(R.summaryBuilt);
    expect(tagNote(spec)).toBe(R.tagNote);
    // The linked page: the same page, written where this run can read it.
    const root = tempDir("phase5-pages");
    const artifacts = join(root, "work", "Shop", ".bot", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const html = `<html><head><title>T</title><style>p{}</style></head><body><h1>Sales &amp; costs</h1><p>Line one<br>two</p><ul><li>a</li><li>b &#x4E2D;</li></ul><table><tr><td>x</td><td>y</td></tr></table><script>var a=1</script></body></html>`;
    writeFileSync(join(artifacts, "report.html"), html);
    expect(pageText(html)).toBe(S.pageText);
    const linked = { ...S.drafts[4].message, text: `See [the report](file://${join(artifacts, "report.html")}) for details.` };
    const pages = replyPages(linked);
    expect(pages).toEqual([{ path: join(artifacts, "report.html"), text: S.pageText }]);
    const golden = (text: string) => text.replaceAll(S.page, join(artifacts, "report.html"));
    const reply = S.drafts[1].message.text;
    expect(swap(draftRequest(spec, reply, pages, "cat x", "Shop"), id)).toBe(swap(golden(R.draft), S.steps.at(-1).spec.id));
    expect(swap(draftRequest(plain, S.drafts[0].message.text, [], null, "Shop"), plain.id)).toBe(swap(R.draftPlain, S.drafts[0].spec.id === undefined ? "" : R.draftPlain.match(/Component spec ([0-9A-F-]{36})/)![1]));
    const sid = S.steps.at(-1).spec.id;
    expect(swap(firstBuildRequest(spec, { reply, pages, asked: "  show me the tests  ", brief: " The brief. ", bot: "Shop" }), id)).toBe(swap(golden(R.firstBuildLive), sid));
    const plainId = R.firstBuildFilled.match(/Component spec ([0-9A-F-]{36})/)![1];
    expect(swap(firstBuildRequest(plain, { reply: S.drafts[0].message.text, ran: "npm test", bot: "Main bot" }), plain.id)).toBe(swap(R.firstBuildFilled, plainId));
    expect(swap(sayRequest(spec, "make it red"), id)).toBe(swap(R.say, sid));
    expect(swap(sayRequest(spec, ""), id)).toBe(swap(R.sayEmpty, sid));
    expect(swap(changeRequest(built as ComponentSpec, [], 3), id)).toBe(swap(R.change0, sid));
    expect(swap(changeRequest(built as ComponentSpec, [" bigger "], 3), id)).toBe(swap(R.change1, sid));
    expect(swap(changeRequest(built as ComponentSpec, ["bigger", "", "green"], 3), id)).toBe(swap(R.change2, sid));
    expect(swap(buildRequest(spec), id)).toBe(swap(R.build, sid));
    expect(swap(buildRequest(plain), plain.id)).toBe(swap(R.buildFilled, R.buildFilled.match(/Component spec ([0-9A-F-]{36})/)![1]));
    expect(boardCommandRequest("test-board", "npm test --json", S.folder, "Shop", "brief")).toBe(R.board);
    expect(boardCommandRequest("test-board", "npm test --json", S.folder, "Shop")).toBe(R.boardNoBrief);
    const message = S.drafts[1].message;
    const when = shortTime(message.date, { timeZone: "UTC", locale: "en-GB", hour12: true });
    expect(fillRequest(spec, "test-board", { text: message.text, when, preview: "Here:" }, [S.page], "- test-board: shows tests")).toBe(R.fill);
    expect(fillRequest(plain, "x", null, [], "")).toBe(R.fillNoReply);
    expect(purposeLine(plain, "Shop")).toBe(R.purposeNone);
    expect(COMPONENT_ACTIONS.map((action) => actionHeader(action, "ID"))).toEqual(R.headers);
    for (const { answer, data, problem } of S.fills) expect([answer, filledData(answer, "test-board")]).toEqual([answer, data !== undefined ? { data } : { problem }]);
  });
});
