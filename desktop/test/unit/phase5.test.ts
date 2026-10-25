// Phase 5a: the strings the rest of Maintainer's component work and the completion checks give the
// bots, equal character for character to what the Swift app wrote (test/fixtures/phase5-golden.json,
// made by Tests/ClaudeCodeBotCoreTests/DesktopPhase5GoldenExport.swift).
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ComponentLibrary, componentMentions } from "../../src/core/components/library";
import { callInPrompt, groupPrompt, transcriptBefore, type Member } from "../../src/core/groups";
import type { ChatRecord } from "../../src/core/store/records";
import { slashLists } from "../../src/renderer/payload";
import { problemReport } from "../../src/core/maintainer";
import type { PinRecord } from "../../src/core/components/pins";
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
    expect(groupPrompt({ member: members[1]!, group: "Pair", members, mainBotId: members[0]!.id, addressed: false, chat: messages, transcript: before, newest, ask: null, speakerName, mentionNote })).toBe(golden.groupTurn);
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
