// `<card title="…">prompt</card>` in a reply: parsed into a worker card request and taken out of the words (reply.ts), kept out of
// a bubble's "says nothing" test (saysNothing, headTurnContent) and held back while the reply streams (streamingText).
import { describe, expect, it } from "vitest";
import { parseReply, saysNothing, cardTitle, CARD_TITLE_MAX } from "../../src/core/reply";
import { streamingText } from "../../src/core/bot/view-functions";
import { headTurnContent } from "../../src/core/head-turn";
import { hasVisibleContent } from "../../src/core/worker-core";

describe("<card> tag: parse and strip", () => {
  it("takes the tag out of the words and keeps title, prompt and where it stood", () => {
    const parsed = parseReply('Let me look it up.\n<card title="Weather">Fetch the 7 day forecast for Taipei.</card>\nBack soon.');
    expect(parsed.cards).toEqual([{ title: "Weather", prompt: "Fetch the 7 day forecast for Taipei.", at: "Let me look it up.\n".length }]);
    expect(parsed.body).toBe("Let me look it up.\n\nBack soon.");
    expect(parsed.body).not.toMatch(/card|/);
  });

  it("the title falls back to the first line of the prompt; single quotes work; a long or multi-line title is one short line", () => {
    expect(parseReply("<card>First line here\nsecond line</card>").cards?.[0]).toMatchObject({ title: "First line here", prompt: "First line here\nsecond line" });
    expect(parseReply("<card title='Quoted'>go</card>").cards?.[0]?.title).toBe("Quoted");
    expect(cardTitle("a\nb\u0007c")).toBe("a b c");
    expect(cardTitle("x".repeat(500))).toHaveLength(CARD_TITLE_MAX);
    expect([...(parseReply(`<card title="${"y".repeat(300)}">go</card>`).cards?.[0]?.title ?? "")]).toHaveLength(CARD_TITLE_MAX);
  });

  it("several cards come out in the order they were written, each with its own place", () => {
    const parsed = parseReply('A <card title="one">p1</card> B <card title="two">p2</card> C');
    expect(parsed.cards?.map((card) => [card.title, card.prompt])).toEqual([["one", "p1"], ["two", "p2"]]);
    expect(parsed.body).toBe("A  B  C");
    expect(parsed.cards?.map((card) => card.at)).toEqual([2, 5]);
  });

  it("an empty or self-closing card starts nothing and leaves no trace", () => {
    for (const raw of ['x <card title="t"></card> y', 'x <card title="t"/> y', 'x <card title="t">   </card> y']) {
      const parsed = parseReply(raw);
      expect(parsed.cards, raw).toBeUndefined();
      expect(parsed.body, raw).toBe("x  y");
    }
  });

  it("a card in a code fence or inline code is text, not a request", () => {
    const fenced = parseReply("Write it like this:\n```\n<card title=\"t\">go</card>\n```");
    expect(fenced.cards).toBeUndefined();
    expect(fenced.body).toContain("<card title=\"t\">go</card>");
    const inline = parseReply("Use `<card title=\"t\">go</card>` to start one.");
    expect(inline.cards).toBeUndefined();
    expect(inline.body).toContain("<card");
  });

  it("an unknown attribute means nothing, and a card does not disturb <show> places", () => {
    const parsed = parseReply('<card title="t" command="rm -rf /">go</card>');
    expect(parsed.cards).toEqual([{ title: "t", prompt: "go", at: 0 }]);
    expect(parsed.requests).toEqual([]);
    const both = parseReply('A <show name="inline-chart">{"x":1}</show> B <card title="t">go</card> C', ["show"]);
    expect(both.displays).toHaveLength(1);
    expect(both.displays[0]?.at).toBe(2);
    expect(both.cards?.[0]?.at).toBe(5);
    expect(both.body).not.toMatch(/[]/);
  });

  it("a reply with no card has no `cards` key", () => {
    expect("cards" in parseReply("just words")).toBe(false);
  });
});

describe("<card> tag: a reply that is only a card still shows", () => {
  it("saysNothing is false for a card alone, true for an empty one", () => {
    expect(saysNothing('<card title="t">go</card>')).toBe(false);
    expect(saysNothing('<card title="t"></card>')).toBe(true);
  });

  it("headTurnContent keeps a card-only reply (a bubble is drawn to hold the card)", () => {
    const raw = '<card title="t">go</card>';
    const parsed = parseReply(raw);
    const content = headTurnContent({ status: "done", origin: "user", sharesChat: false, raw, parsed, body: parsed.body, handoff: false, steps: 0, error: null });
    expect(hasVisibleContent(content)).toBe(true);
    expect(content.cards).toBe(1);
  });

  it("a reaction plus a card is not a reply that only reacts: the card's bubble is kept", () => {
    const raw = '<reaction message="11111111-2222-3333-4444-555555555555" emoji="👍" present="true"/>\n<card title="t">go</card>';
    const parsed = parseReply(raw);
    expect(parsed.reactions).toHaveLength(1);
    const content = headTurnContent({ status: "done", origin: "user", sharesChat: false, raw, parsed, body: parsed.body, handoff: false, steps: 0, error: null });
    expect(content.reactionsOnly).toBe(false);
    expect(hasVisibleContent(content)).toBe(true);
  });
});

describe("<card> tag: streaming", () => {
  it("a card still being written is held back, a finished one is gone from the shown text", () => {
    expect(streamingText('Looking.\n<card title="t">fetch the da')).toBe("Looking.");
    expect(streamingText('Looking.\n<card title="t">fetch</card> ok')).not.toMatch(/<card/);
  });
});
