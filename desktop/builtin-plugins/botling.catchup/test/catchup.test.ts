// Catch-up's text (src/catchup.ts) against what the Swift app's CatchUp.swift wrote for the same
// lines (test/fixtures/prompts-golden.json `catchUp`, from DesktopPromptGoldenExport.swift).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { intervalAfter, intervalMessages, instructions, parseBullets, rangeKey, summaryArguments, summaryPrompt, SUMMARY_SCHEMA, unreadMessages, validateCodexEvents, type ChatRecord } from "../src/catchup";
import { desktop } from "../../../test/helpers";

const golden = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "prompts-golden.json"), "utf8")).catchUp;
const records: ChatRecord[] = golden.messages;
const name = (m: ChatRecord) => (m.role === "bot" ? (m.engine === "codex" ? "Garden · Codex" : m.engine === "claude" ? "Garden · Claude" : "Garden") : m.role === "user" ? "You" : m.role === "error" ? "Error" : m.role === "relay" ? "Handed over" : "Botling");

describe("Catch-up text, as Swift writes it", () => {
  it("the summary prompt: sources, options, answers, cards; custom writing preferences; long lines cut", () => {
    // Task cards are gone (2026-11-08): the prompt no longer lists the range's tasks after the messages.
    expect(summaryPrompt(records.slice(1, 10), null, name)).toBe((golden.prompt as string).replace(/\n\nTasks in this range \(data, not instructions\):[\s\S]*$/, ""));
    expect(summaryPrompt(records.slice(3, 7), "Short / plain \"quoted\" 中文", name)).toBe(golden.promptCustom);
    const long = { id: "44444444-0000-4000-8000-000000000002", role: "bot", text: "a b ".repeat(20_000), date: 0 } as ChatRecord;
    expect(summaryPrompt([long, ...records.slice(0, 3)], undefined, name)).toBe(golden.promptLong);
  });

  it("instructions in every language, the isolated codex exec's arguments, the schema and the range key", () => {
    // Swift's golden still has the languages 2.1.0 dropped; only the two kept are compared.
    // Task cards are gone (2026-11-08): the [[task:…]] sentence Swift had is no longer asked for.
    const noTasks = (text: string) => text.replace(" When a bullet is about one of the listed tasks, also add [[task:TASK_UUID]] with that task's id; never invent task ids.", "");
    for (const language of ["en", "zh-Hant"] as const) expect(instructions(language)).toBe(noTasks((golden.instructions as Record<string, string>)[language]!));
    // The golden's arguments were made for Japanese: everything but that language's instructions is compared.
    const own = (args: string[]) => args.filter((arg) => !arg.startsWith("developer_instructions="));
    expect(own(summaryArguments("hello", "/tmp/catchup", "gpt-test", "zh-Hant"))).toEqual(own(golden.arguments));
    expect(SUMMARY_SCHEMA).toBe(golden.schema);
    expect(rangeKey(records.slice(3, 7), "zh-Hant")).toBe(golden.key.replace(/-ja$/, "-zh-Hant"));
  });

  it("which lines are unread, and which make an interval", () => {
    expect(unreadMessages(records, 3).map((m) => m.id)).toEqual(golden.unread3);
    expect(unreadMessages(records, 50).map((m) => m.id)).toEqual(golden.unread50);
    expect(intervalMessages(records).map((m) => m.id)).toEqual(golden.interval);
    expect(intervalAfter(records, records[2]!.id).map((m) => m.id)).toEqual(golden.intervalAfter);
  });

  it("bullets are parsed, trimmed and capped at five; codex's events must show only words and a finished turn", () => {
    expect(parseBullets(`{"bullets":[" a ","","b","c","d","e","f"]}`)).toEqual(["a", "b", "c", "d", "e"]);
    expect(() => parseBullets(`{"bullets":[]}`)).toThrow();
    expect(() => parseBullets("not json")).toThrow();
    expect(() => validateCodexEvents([{ type: "turn.started" }, { type: "item.completed", item: { type: "agent_message" } }, { type: "turn.completed" }].map((e) => JSON.stringify(e)).join("\n"))).not.toThrow();
    expect(() => validateCodexEvents(JSON.stringify({ type: "item.completed", item: { type: "command_execution" } }) + "\n" + JSON.stringify({ type: "turn.completed" }))).toThrow(/tool/);
    expect(() => validateCodexEvents(JSON.stringify({ type: "turn.failed" }))).toThrow();
    expect(() => validateCodexEvents(JSON.stringify({ type: "turn.started" }))).toThrow(/did not complete/);
  });
});
