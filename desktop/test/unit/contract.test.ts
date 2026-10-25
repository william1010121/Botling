import { describe, expect, it } from "vitest";
import { CARD_SAVE_LIMIT, CardMessage, EventEnvelope, PROTOCOL_VERSION, parseInbound } from "../../src/contract";

const bot = "6A0B0000-0000-4000-8000-000000000002";

describe("contract", () => {
  it("accepts a well-formed request and cancel", () => {
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "chat.send", botId: bot, text: "hi" } }).ok).toBe(true);
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "chat.snapshot" } }).ok).toBe(true);
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "chat.choose", botId: bot, messageId: "m", index: 0 } }).ok).toBe(true);
    expect(parseInbound({ v: 8, cancel: "r1" }).ok).toBe(true);
  });

  it("takes the two-head commands (v4) and refuses heads it does not know", () => {
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "chat.send", botId: bot, text: "hi", to: "codex" } }).ok).toBe(true);
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "chat.send", botId: bot, text: "hi", to: "gemini" } }).ok).toBe(false);
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "heads.set", botId: bot, engines: ["claude", "codex"] } }).ok).toBe(true);
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "heads.set", botId: bot, engines: [] } }).ok).toBe(false);
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "heads.answerWith", botId: bot, to: "both" } }).ok).toBe(true);
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "handoff.stop", botId: bot, handoffId: "H-1" } }).ok).toBe(true);
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "rounds.stop", botId: bot } }).ok).toBe(true);
    expect(parseInbound({ v: 3, id: "r1", cmd: { type: "chat.snapshot" } })).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
  });

  it("refuses another protocol version with its own code", () => {
    expect(parseInbound({ v: 1, id: "r1", cmd: { type: "chat.snapshot" } })).toMatchObject({ ok: false, id: "r1", error: { code: "unsupported_version" } });
    expect(parseInbound({ v: 2, id: "r1", cmd: { type: "chat.snapshot" } })).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
  });

  it("refuses unknown commands, unknown fields, missing bots and bad ids", () => {
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "shell.run", command: "rm -rf /" } })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "chat.snapshot", botId: bot, extra: 1 } })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "chat.send", text: "no bot" } })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "chat.send", botId: "../main", text: "x" } })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "chat.choose", botId: bot, messageId: "m", index: -1 } })).toMatchObject({ ok: false });
    expect(parseInbound({ v: 8, id: "../etc", cmd: { type: "chat.snapshot" } })).toMatchObject({ ok: false, id: null });
    expect(parseInbound(null).ok).toBe(false);
    expect(parseInbound("text").ok).toBe(false);
  });

  it("bounds sizes", () => {
    // An empty text is a message of files only (the core refuses it when none wait).
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "chat.send", botId: bot, text: "" } }).ok).toBe(true);
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "chat.send", botId: bot, text: "x".repeat(100_001) } }).ok).toBe(false);
    const big = "x".repeat(CARD_SAVE_LIMIT + 1);
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "card.save", botId: bot, messageId: "m", cardId: "c", data: big } }).ok).toBe(false);
    expect(CARD_SAVE_LIMIT).toBe(262144); // Shared with the Swift app through Web/src/contract.json.
  });

  it("only lets sites open over http(s)", () => {
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "site.open", accountId: "work", url: "https://example.com" } }).ok).toBe(true);
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "site.open", accountId: "work", url: "file:///etc/passwd" } }).ok).toBe(false);
    expect(parseInbound({ v: 8, id: "r1", cmd: { type: "site.open", accountId: "work", url: "javascript:alert(1)" } }).ok).toBe(false);
  });

  it("card messages are strict: no smuggled ids", () => {
    expect(CardMessage.safeParse({ ccb: "save", data: "{}" }).success).toBe(true);
    expect(CardMessage.safeParse({ ccb: "save", data: "{}", botId: "b2" }).success).toBe(false);
    expect(CardMessage.safeParse({ ccb: "save", data: "{}", cardId: "c2" }).success).toBe(false);
    expect(CardMessage.safeParse({ ccb: "shell", command: "ls" }).success).toBe(false);
    expect(CardMessage.safeParse({ ccb: "action", name: "Run Shell", value: "" }).success).toBe(false);
  });

  it("events carry epoch, a non-negative integer seq and their bot", () => {
    const event = { type: "turn.delta", botId: bot, turnId: "t", messageId: "m", text: "a" };
    expect(EventEnvelope.safeParse({ v: PROTOCOL_VERSION, epoch: "e", seq: 3, event }).success).toBe(true);
    expect(EventEnvelope.safeParse({ v: PROTOCOL_VERSION, epoch: "e", seq: -1, event }).success).toBe(false);
    expect(EventEnvelope.safeParse({ v: PROTOCOL_VERSION, epoch: "e", seq: 1.5, event }).success).toBe(false);
    expect(EventEnvelope.safeParse({ v: PROTOCOL_VERSION, epoch: "e", seq: 1, event: { ...event, botId: undefined } }).success).toBe(false);
  });
});
