import { describe, expect, it } from "vitest";
import { CARD_SAVE_LIMIT, CardMessage, EventEnvelope, PROTOCOL_VERSION, parseInbound } from "../../src/contract";

describe("contract", () => {
  it("accepts a well-formed request and cancel", () => {
    expect(parseInbound({ v: 1, id: "r1", cmd: { type: "chat.send", text: "hi" } }).ok).toBe(true);
    expect(parseInbound({ v: 1, cancel: "r1" }).ok).toBe(true);
  });

  it("refuses another protocol version with its own code", () => {
    const result = parseInbound({ v: 2, id: "r1", cmd: { type: "chat.snapshot" } });
    expect(result).toMatchObject({ ok: false, id: "r1", error: { code: "unsupported_version" } });
  });

  it("refuses unknown commands, unknown fields and bad ids", () => {
    expect(parseInbound({ v: 1, id: "r1", cmd: { type: "shell.run", command: "rm -rf /" } })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(parseInbound({ v: 1, id: "r1", cmd: { type: "chat.snapshot", botId: "other" } })).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(parseInbound({ v: 1, id: "../etc", cmd: { type: "chat.snapshot" } })).toMatchObject({ ok: false, id: null });
    expect(parseInbound(null).ok).toBe(false);
    expect(parseInbound("text").ok).toBe(false);
  });

  it("bounds sizes", () => {
    expect(parseInbound({ v: 1, id: "r1", cmd: { type: "chat.send", text: "" } }).ok).toBe(false);
    const big = "x".repeat(CARD_SAVE_LIMIT + 1);
    expect(parseInbound({ v: 1, id: "r1", cmd: { type: "card.save", messageId: "m", cardId: "c", data: big } }).ok).toBe(false);
    expect(CARD_SAVE_LIMIT).toBe(262144); // Shared with the Swift app through Web/src/contract.json.
  });

  it("only lets sites open over http(s)", () => {
    expect(parseInbound({ v: 1, id: "r1", cmd: { type: "site.open", accountId: "work", url: "https://example.com" } }).ok).toBe(true);
    expect(parseInbound({ v: 1, id: "r1", cmd: { type: "site.open", accountId: "work", url: "file:///etc/passwd" } }).ok).toBe(false);
    expect(parseInbound({ v: 1, id: "r1", cmd: { type: "site.open", accountId: "work", url: "javascript:alert(1)" } }).ok).toBe(false);
  });

  it("card messages are strict: no smuggled ids", () => {
    expect(CardMessage.safeParse({ ccb: "save", data: "{}" }).success).toBe(true);
    expect(CardMessage.safeParse({ ccb: "save", data: "{}", botId: "b2" }).success).toBe(false);
    expect(CardMessage.safeParse({ ccb: "save", data: "{}", cardId: "c2" }).success).toBe(false);
    expect(CardMessage.safeParse({ ccb: "shell", command: "ls" }).success).toBe(false);
    expect(CardMessage.safeParse({ ccb: "action", name: "Run Shell", value: "" }).success).toBe(false);
  });

  it("events carry epoch and a non-negative integer seq", () => {
    const event = { type: "turn.delta", turnId: "t", messageId: "m", text: "a" };
    expect(EventEnvelope.safeParse({ v: PROTOCOL_VERSION, epoch: "e", seq: 3, event }).success).toBe(true);
    expect(EventEnvelope.safeParse({ v: PROTOCOL_VERSION, epoch: "e", seq: -1, event }).success).toBe(false);
    expect(EventEnvelope.safeParse({ v: PROTOCOL_VERSION, epoch: "e", seq: 1.5, event }).success).toBe(false);
  });
});
