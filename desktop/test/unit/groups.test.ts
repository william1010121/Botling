// Call-ins and bots' @ (Phase 4c): the strings a guest bot is told, equal character for
// character to what the Swift app wrote (test/fixtures/groups-golden.json, made by
// Tests/ClaudeCodeBotCoreTests/DesktopGroupsGoldenExport.swift).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  botCallInPrompt, botMentionCandidates, callInNote, callInPrompt, heardSinceLastTurn, isPass, mentioned,
  oneLine, quoteName, reactionSnapshot, transcriptBefore, transcriptLines, type Member,
} from "../../src/core/groups";
import type { ChatRecord } from "../../src/core/store/records";

const golden = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "groups-golden.json"), "utf8"));
const members: Member[] = golden.members;
const ids: Record<string, string> = golden.ids;
const member = (id: string) => members.find((candidate) => candidate.id === id)!;
const speakerName = (id: string) => members.find((candidate) => candidate.id === id)?.name ?? null;
const messages: ChatRecord[] = golden.messages;
const before = transcriptBefore(golden.newest, messages);

describe("guests' strings (GroupChat.swift, CallIn.swift, BotMentions.swift)", () => {
  it("the transcript, the reaction snapshot and the lines a guest is shown", () => {
    expect(before.map((message) => message.id)).toEqual(golden.before);
    expect(transcriptLines(messages, golden.newest, speakerName, 'Main "bot"')).toEqual(golden.transcript);
    expect(transcriptLines(messages, null, speakerName)).toEqual(golden.transcriptNoHost);
    expect(reactionSnapshot(messages, before.at(-1)?.id)).toBe(golden.snapshot);
    expect(reactionSnapshot(messages, null)).toBe(golden.snapshotAll);
  });

  it("a call-in by the user and by a bot's @, the notes to the chat's own bot", () => {
    const base = { host: "Main bot", chat: messages, speakerName };
    expect(callInPrompt({ ...base, member: member(ids.shop!), transcript: before, newest: golden.newest, ask: null })).toBe(golden.callIn);
    expect(callInPrompt({ ...base, member: member(ids.shop!), transcript: before, newest: null, ask: "The user picked: Yes" })).toBe(golden.callInAsk);
    expect(callInPrompt({ ...base, member: member(ids.maintainer!), transcript: [], newest: null, ask: null })).toBe(golden.callInEmpty);
    expect(botCallInPrompt({ ...base, member: member(ids.maintainer!), transcript: before, body: "is the flag component still yours?" })).toBe(golden.botCallIn);
    expect(botCallInPrompt({ ...base, member: member(ids.maintainer!), transcript: before, body: "" })).toBe(golden.botCallInEmpty);
    expect(callInNote([member(ids.shop!)])).toBe(golden.callInNote1);
    expect(callInNote([member(ids.shop!), member(ids.maintainer!)])).toBe(golden.callInNote2);
    expect(callInNote([])).toBeNull();
    expect(heardSinceLastTurn(messages, speakerName)).toBe(golden.heard);
  });

  it("mentions, the lines that may call a bot, PASS, names", () => {
    for (const { text, found } of golden.candidates) expect(botMentionCandidates(text)).toEqual(found);
    for (const { text, ids: named } of golden.mentioned) expect(mentioned(text, members).map((m) => m.id)).toEqual(named);
    for (const { text, pass } of golden.pass) expect([text, isPass(text)]).toEqual([text, pass]);
    for (const { text, line } of golden.oneLine) expect(oneLine(text, 40)).toBe(line);
    for (const { text, quoted } of golden.quoteNames) expect(quoteName(text)).toBe(quoted);
  });
});
