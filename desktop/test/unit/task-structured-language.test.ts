import { describe, expect, it } from "vitest";
import { TaskBook } from "../../src/core/tasks";
import { parseReply } from "../../src/core/reply";
import { StreamJsonReader } from "../../src/core/agent/runner";

const prose = [
  "not finished",
  'The participant quoted "stop"; continue the experiment.',
  "Research about completion and stopping criteria remains in progress.",
  "尚未完成，請繼續研究。",
  "這是在討論「停止」條件，不是要求停止任務。",
  "还没完成，不要停止。",
  "Finished. Stop. 完成。停止。",
];

describe("lifecycle requires structured signals independently of prose", () => {
  it.each(prose)("does not close cards or end a streaming turn for %s", (text) => {
    for (const state of ["running", "waiting"] as const) {
      const book = new TaskBook();
      const id = book.begin("user", text, "claude", 1);
      book.replied("start", { head: "claude", userMessage: "user" },
        [{ name: "Completion research", state }], 2);
      const parsed = parseReply(text);
      expect(parsed.tasks).toEqual([]);
      book.replied("reply", { head: "claude", userMessage: "user", userText: text }, parsed.tasks, 3);
      expect(book.task(id)!.state).toBe(state);
      // Progress fields are data too, never terminal keywords.
      book.replied("progress", { head: "claude", userMessage: "user" },
        parseReply(`<task now='${text}'/>`).tasks, 4);
      expect(book.task(id)!.state).toBe(state);
      expect(book.task(id)!.history!.some(event => event.kind === "done" || event.kind === "stopped")).toBe(false);
    }
    const outcomes: unknown[] = [];
    const reader = new StreamJsonReader({ onDelta() {}, onFinish: result => outcomes.push(result) });
    reader.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n");
    expect(reader.soFar).toBe(text);
    expect(reader.finished).toBeNull();
    expect(outcomes).toEqual([]);
    reader.push(JSON.stringify({ type: "result", subtype: "success", result: text }) + "\n");
    expect(outcomes).toEqual([{ status: "done", text }]);
  });

  it.each(["done", "stopped"] as const)("accepts an owner's explicit %s without terminal prose", (state) => {
    const book = new TaskBook();
    const id = book.begin("user", "Research", "claude", 1);
    book.replied("start", { head: "claude", userMessage: "user" }, [{ name: "Research", state: "running" }], 2);
    book.replied("reply", { head: "claude", userMessage: "user" },
      parseReply(`<task id="${id}" expected-updated-at="2" state="${state}"/>`).tasks, 3);
    expect(book.task(id)).toMatchObject({ state, stateFromTag: state, updatedAt: 3 });
    expect(book.task(id)!.history!.at(-1)!.kind).toBe(state);
  });
});
