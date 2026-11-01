// TextBlocks (shared-core spec 2.2): chunks join into one block that closes at a break, a tool, a whole message or the
// end; the whole message replaces its own chunks; `last` is the newest non-commentary block. ReplyText moved to
// worker-core and is still the one agent/stream.ts exports.
import { describe, expect, it } from "vitest";
import { ReplyText as StreamReplyText } from "../../src/core/agent/stream";
import { ReplyText, TextBlocks } from "../../src/core/worker-core/text";
import type { WorkerEvent } from "../../src/core/worker-core/events";

const delta = (text: string): WorkerEvent => ({ type: "textDelta", text });
const whole = (text: string, phase: "commentary" | "final" | null = null): WorkerEvent => ({ type: "textWhole", text, phase });
const tool: WorkerEvent = { type: "toolUse", id: "t1", tool: "Bash", title: "Run git status", detail: "git status", input: {} };
const result: WorkerEvent = { type: "toolResult", id: "t1", output: "fatal", failed: true };
const end: WorkerEvent = { type: "end", end: { how: "normal", finalText: null, error: null, detail: "" } };

function run(events: WorkerEvent[]) {
  const blocks = new TextBlocks();
  const closed = events.flatMap((e) => blocks.add(e));
  return { closed: [...closed, ...blocks.flush()], last: blocks.last };
}

describe("TextBlocks", () => {
  it("chunks that cut words and code spans close as one block (ACP agent_message_chunk)", () => {
    const { closed, last } = run([delta("The id is `05B4"), delta("4DD6-73"), delta("BB` and"), delta(" more."), end]);
    expect(closed).toEqual([{ text: "The id is `05B44DD6-73BB` and more.", phase: null }]);
    expect(last).toBe("The id is `05B44DD6-73BB` and more.");
  });

  it("a delta closes nothing", () => {
    const blocks = new TextBlocks();
    expect(blocks.add(delta("half"))).toEqual([]);
    expect(blocks.last).toBe("");
  });

  it("textBreak, toolUse, toolResult and end each close the open block", () => {
    expect(run([delta("a"), { type: "textBreak" }, delta("b"), tool, delta("c"), result, delta("d"), end]).closed.map((b) => b.text)).toEqual(["a", "b", "c", "d"]);
  });

  it("blank blocks are not shown", () => {
    expect(run([delta("  \n"), tool, { type: "textBreak" }, end]).closed).toEqual([]);
  });

  it("the whole message replaces the chunks it was streamed as (claude sends both)", () => {
    expect(run([{ type: "textBreak" }, delta("Hel"), delta("lo wor"), whole("Hello world."), tool, end]).closed).toEqual([{ text: "Hello world.", phase: null }]);
  });

  it("whole messages alone are one block each (Codex agentMessage), commentary included but never the report", () => {
    const { closed, last } = run([whole("Looking at the repo.", "commentary"), tool, result, whole("DONE — git failed as expected.", "final"), whole("(aside)", "commentary"), end]);
    expect(closed.map((b) => [b.text, b.phase])).toEqual([["Looking at the repo.", "commentary"], ["DONE — git failed as expected.", "final"], ["(aside)", "commentary"]]);
    expect(last).toBe("DONE — git failed as expected.");
  });

  it("last is the newest block (D1: an agy report is its last text block, not the whole turn's text)", () => {
    expect(run([delta("First I will look."), tool, result, delta("All done: 3 files."), end]).last).toBe("All done: 3 files.");
  });

  it("flush with nothing open closes nothing", () => {
    expect(new TextBlocks().flush()).toEqual([]);
  });
});

describe("ReplyText (the head's reply), moved to worker-core", () => {
  it("is the class agent/stream.ts exports", () => {
    expect(StreamReplyText).toBe(ReplyText);
  });

  it("keeps its behaviour: deltas, paragraphs after a new block, whole messages only without deltas, the result's text as a fallback", () => {
    const reply = new ReplyText();
    reply.add({ kind: "delta", text: "One" });
    reply.add({ kind: "textBlock" });
    reply.add({ kind: "delta", text: "Two" });
    reply.add({ kind: "assistantText", text: "ignored" });
    expect(reply.text).toBe("One\n\nTwo");
    const fallback = new ReplyText();
    expect(fallback.add({ kind: "result", ok: true, text: "From result", error: "", subtype: "success" })).toBe("From result");
  });
});
