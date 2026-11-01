// A head turn's end and whether it shows a bubble, through the shared worker core (shared-core spec 2.7, 2.8, slice
// S4a). The end: classifyRun with requireReply false gives what `item.ok` gave for every engine's result today. The
// bubble: every turn source × with/without content against today's four `silent` clauses (bot.ts, kept below as the
// oracle); the only difference is D5, your message answered with nothing gets no blank bubble.
import { describe, expect, it } from "vitest";
import type { StreamItem } from "../../src/core/agent/stream";
import { headTurnContent, headTurnEnd, type HeadTurnFacts } from "../../src/core/head-turn";
import { parseHeadTags } from "../../src/core/heads";
import { parseReply, saysNoReply, saysNothing } from "../../src/core/reply";
import { hasVisibleContent } from "../../src/core/worker-core";

type Result = Extract<StreamItem, { kind: "result" }>;
const result = (over: Partial<Result>): Result => ({ kind: "result", ok: true, text: "", error: "", subtype: "success", ...over });

describe("a head turn's end (classifyRun, requireReply false)", () => {
  it("Claude: a normal end is done, with or without words; an error is failed with the engine's words", () => {
    expect(headTurnEnd(result({ how: "normal", text: "Hi" }), "Hi", "claude")).toEqual({ status: "done" });
    expect(headTurnEnd(result({ how: "normal" }), "", "claude")).toEqual({ status: "done" });
    expect(headTurnEnd(result({ ok: false, how: "error", subtype: "error_max_turns", error: "Reached max turns" }), "half", "claude"))
      .toEqual({ status: "failed", error: "Reached max turns" });
  });

  it("Claude and Codex count no failed tools of their own: a silent turn after a failed tool stays done", () => {
    // The spec's steps.filter(failed) would turn these into failures; only engines that send failedTools (agy, S2) do.
    expect(headTurnEnd(result({ how: "normal" }), "", "claude")).toEqual({ status: "done" });
    expect(headTurnEnd(result({ ok: true }), "", "codex")).toEqual({ status: "done" });
  });

  it("engines that do not send `how` yet (Codex, Antigravity before S2/S3) end as their `ok` says", () => {
    expect(headTurnEnd(result({ ok: true, text: "Done." }), "Done.", "codex")).toEqual({ status: "done" });
    expect(headTurnEnd(result({ ok: false, error: "turn failed", subtype: "error" }), "", "codex")).toEqual({ status: "failed", error: "turn failed" });
    expect(headTurnEnd(result({ ok: true, subtype: "end_turn" }), "", "agy")).toEqual({ status: "done" });
    expect(headTurnEnd(result({ ok: false, subtype: "tool_failed", error: "Antigravity stopped: tool_failed" }), "", "agy"))
      .toEqual({ status: "failed", error: "Antigravity stopped: tool_failed" });
    expect(headTurnEnd(result({ ok: false, subtype: "cancelled", error: "Antigravity stopped: cancelled" }), "", "agy"))
      .toEqual({ status: "failed", error: "Antigravity stopped: cancelled" });
  });

  it("Antigravity after S2 (how + failedTools): a normal end with a reply is done whatever failed; silence after a failed tool is failed", () => {
    expect(headTurnEnd(result({ how: "normal", failedTools: 2, text: "Fixed it." }), "Fixed it.", "agy")).toEqual({ status: "done" });
    expect(headTurnEnd(result({ ok: false, how: "normal", failedTools: 1, error: "Antigravity stopped: tool_failed" }), "", "agy"))
      .toEqual({ status: "failed", error: "Antigravity stopped: tool_failed" });
    // An engine that said ok anyway gets classifyRun's words for it.
    expect(headTurnEnd(result({ how: "normal", failedTools: 1 }), "", "agy")).toEqual({ status: "failed", error: "Antigravity stopped after a failed tool." });
  });

  it("an engine's cancel or exit is a failed head turn (a head turn is done or failed), with the engine's words", () => {
    expect(headTurnEnd(result({ ok: false, how: "cancelled", error: "Antigravity stopped: cancelled" }), "", "agy")).toEqual({ status: "failed", error: "Antigravity stopped: cancelled" });
    expect(headTurnEnd(result({ ok: false, how: "exited", error: "exit 1" }), "partial", "codex")).toEqual({ status: "failed", error: "exit 1" });
  });

  it("parity: every result without `how` ends exactly as `item.ok` did", () => {
    for (const engine of ["claude", "codex", "agy"] as const)
      for (const ok of [true, false])
        for (const reply of ["", "words"])
          for (const failedTools of [undefined, 0]) {
            const item = result({ ok, failedTools, error: ok ? "" : "boom", text: reply });
            expect(headTurnEnd(item, reply, engine).status, `${engine} ok=${ok} reply=${!!reply}`).toBe(ok ? "done" : "failed");
          }
  });
});

// ---------------------------------------------------------------------------------------------------------------------

type Origin = HeadTurnFacts["origin"];
type Status = HeadTurnFacts["status"];

/** bot.ts's `silent` before S4a, word for word: the oracle. */
function legacySilent(raw: string, status: Status, origin: Origin, sharesChat: boolean, steps: number): boolean {
  const parsed = parseReply(raw);
  const tags = status === "done" ? parseHeadTags(parsed.body) : { body: parsed.body, handoff: null };
  const nothing = saysNothing(raw);
  return status === "done" && !tags.handoff && (
    (nothing && (parsed.reactions.length > 0 || !!parsed.whiteboard))
    || (origin === "background" && (saysNoReply(raw) || nothing))
    || ((origin === "app" || sharesChat) && nothing && saysNoReply(raw))
    || (origin === "app" && nothing && !parsed.decisionReference && !steps));
}

/** What finishTurn hands headTurnContent. */
function facts(raw: string, status: Status, origin: Origin, sharesChat: boolean, steps: number): HeadTurnFacts {
  const parsed = parseReply(raw);
  const tags = status === "done" ? parseHeadTags(parsed.body) : { body: parsed.body, handoff: null };
  return { status, origin, sharesChat, raw, parsed, body: tags.body, handoff: !!tags.handoff, steps, error: status === "done" ? null : "It broke." };
}

const silent = (raw: string, status: Status, origin: Origin, sharesChat: boolean, steps: number) =>
  !hasVisibleContent(headTurnContent(facts(raw, status, origin, sharesChat, steps)));

const MESSAGE = "9C3E2B1A-7F4D-4A6B-8E2C-5D1F0A9B3C47";
const DECISION = "4D1B6A0E-3C55-4E8B-9A57-2D6C0B1F9E10";
const REPLIES: Record<string, string> = {
  words: "Here is the answer.",
  empty: "",
  whitespace: "  \n ",
  noReply: "<no-reply/>",
  wordsAndNoReply: "Noted.\n<no-reply/>",
  reaction: `<reaction message="${MESSAGE}" emoji="👍" present="true"/>`,
  reactionAndWords: `Thanks!\n<reaction message="${MESSAGE}" emoji="👍" present="true"/>`,
  whiteboard: '<whiteboard name="status">{"ok":true}</whiteboard>',
  choices: "<choices>\n* Fast | today\n- Slow\n</choices>",
  display: '<show name="chart">{"points":[1,2]}</show>',
  request: '<component name="Clock">A clock</component>',
  decision: `<decision-ref id="${DECISION}"/>`,
  handoff: '<handoff to="codex">Review the patch</handoff>',
  noReplyInCode: "```\n<no-reply/>\n```",
};
const ORIGINS: Origin[] = ["user", "app", "background"];
const STATUSES: Status[] = ["done", "failed", "stopped"];

describe("a head turn's bubble (hasVisibleContent)", () => {
  it("every turn source × every kind of reply × with/without steps × status: today's rule, except D5", () => {
    const changed: string[] = [];
    for (const [name, raw] of Object.entries(REPLIES))
      for (const status of STATUSES)
        for (const origin of ORIGINS)
          for (const sharesChat of [false, true])
            for (const steps of [0, 2]) {
              const was = legacySilent(raw, status, origin, sharesChat, steps);
              const now = silent(raw, status, origin, sharesChat, steps);
              if (was !== now) changed.push(`${name}/${status}/${origin}/${sharesChat ? "two heads" : "one head"}/${steps} steps: ${was ? "silent" : "bubble"} → ${now ? "silent" : "bubble"}`);
            }
    // D5: your message answered with nothing (no words, buttons, displays, requests, decision or steps) gets no blank bubble.
    expect(changed.sort()).toEqual([
      "empty/done/user/one head/0 steps: bubble → silent",
      "empty/done/user/two heads/0 steps: bubble → silent",
      "noReply/done/user/one head/0 steps: bubble → silent",
      "whitespace/done/user/one head/0 steps: bubble → silent",
      "whitespace/done/user/two heads/0 steps: bubble → silent",
    ]);
  });

  it("D5: your message answered with nothing or only <no-reply/> shows no bubble; with its steps it does", () => {
    expect(silent("", "done", "user", false, 0)).toBe(true);
    expect(silent("<no-reply/>", "done", "user", false, 0)).toBe(true);
    expect(silent("", "done", "user", false, 1)).toBe(false);
    expect(silent(`<decision-ref id="${DECISION}"/>`, "done", "user", false, 0)).toBe(false);
  });

  it("claude's own turn shows only words it chose to say: nothing, <no-reply/> (even with words) and its steps stay out", () => {
    expect(silent("", "done", "background", false, 0)).toBe(true);
    expect(silent("", "done", "background", false, 3)).toBe(true);
    expect(silent("Noted.\n<no-reply/>", "done", "background", false, 0)).toBe(true);
    expect(silent("The research finished.", "done", "background", false, 3)).toBe(false);
  });

  it("the app's note: silent when answered with nothing, no decision and no steps, or with <no-reply/> whatever its steps", () => {
    expect(silent("", "done", "app", false, 0)).toBe(true);
    expect(silent("", "done", "app", false, 1)).toBe(false);
    expect(silent(`<decision-ref id="${DECISION}"/>`, "done", "app", false, 0)).toBe(false);
    expect(silent("<no-reply/>", "done", "app", false, 4)).toBe(true);
  });

  it("with two heads, the head with nothing to add to your message says only <no-reply/>: no bubble, steps and all", () => {
    expect(silent("<no-reply/>", "done", "user", true, 0)).toBe(true);
    expect(silent("<no-reply/>", "done", "user", true, 2)).toBe(true);
  });

  it("a reply that only reacts or sets the whiteboard: no bubble, even with steps; with words, a bubble", () => {
    const content = headTurnContent(facts(REPLIES.reaction!, "done", "user", false, 2));
    expect(content.reactionsOnly).toBe(true);
    expect(hasVisibleContent(content)).toBe(false);
    expect(silent('<whiteboard name="status">{"ok":true}</whiteboard>', "done", "user", false, 0)).toBe(true);
    expect(silent(REPLIES.reactionAndWords!, "done", "user", false, 0)).toBe(false);
  });

  it("buttons, displays and requests show (a request is acted on with its bubble)", () => {
    for (const origin of ORIGINS.filter((o) => o !== "background")) {
      expect(silent(REPLIES.choices!, "done", origin, false, 0)).toBe(false);
      expect(silent(REPLIES.display!, "done", origin, false, 0)).toBe(false);
      expect(silent(REPLIES.request!, "done", origin, false, 0)).toBe(false);
    }
  });

  it("a hand-off, a failed or a stopped turn always shows, whatever it said and whoever started it", () => {
    for (const origin of ORIGINS) {
      expect(silent(REPLIES.handoff!, "done", origin, false, 0)).toBe(false);
      expect(silent("", "failed", origin, false, 0)).toBe(false);
      expect(silent("<no-reply/>", "stopped", origin, true, 0)).toBe(false);
    }
  });

  it("<no-reply/> inside code is words, not the tag", () => {
    expect(silent(REPLIES.noReplyInCode!, "done", "background", false, 0)).toBe(false);
  });

  it("background work alone never makes a bubble: a silent turn hands it to the head's latest reply (keepTasks)", () => {
    expect(headTurnContent(facts("", "done", "app", false, 0)).backgroundTasks).toBe(0);
  });
});
