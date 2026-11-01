// The owner's tags: <agent-message to="id">words</agent-message>, <agent-stop to="id"/>, and <sub-bot subagents="a,b">; each
// leaves the reply, and none flashes in the bubble while the reply streams.
import { describe, expect, it } from "vitest";
import { parseReply } from "../../src/core/reply";
import { streamingText } from "../../src/core/bot";
import { workerSubBotRule } from "../../src/core/prompts";

describe("agent tags", () => {
  it("parses a follow-up and a stop into requests and takes them out of the reply", () => {
    const parsed = parseReply('Asked it to check v2.\n<agent-message to="ag-0123456789abcdef01234567">Also check v2 of the API.</agent-message>\n<agent-stop to=\'task-9\'/>');
    expect(parsed.body.trim()).toBe("Asked it to check v2.");
    expect(parsed.requests).toEqual([
      { kind: "agentMessage", to: "ag-0123456789abcdef01234567", text: "Also check v2 of the API." },
      { kind: "agentStop", to: "task-9" },
    ]);
  });

  it("ignores a tag with no target or no words, and tags inside code", () => {
    expect(parseReply('<agent-message to="">x</agent-message>').requests).toEqual([]);
    expect(parseReply("`<agent-stop to=\"a\"/>`").requests).toEqual([]);
  });

  it("parses several workers for one new sub bot, with its task", () => {
    const parsed = parseReply('Moved to Client.\n<sub-bot name="Client" subagents="task-1, task-2,task-1">Finish the client.</sub-bot>');
    expect(parsed.requests).toEqual([{ kind: "subBot", name: "Client", subagent: "", note: "Finish the client.", subagents: ["task-1", "task-2"] }]);
    expect(parseReply('<sub-bot name="Client" subagents="task-1"/>').requests).toEqual([{ kind: "subBot", name: "Client", subagent: "", note: "", subagents: ["task-1"] }]);
  });

  it("hides them while the reply streams", () => {
    expect(streamingText('Sending.\n<agent-message to="ag-1">Also che')).toBe("Sending.");
    expect(streamingText('Stopping.\n<agent-stop to="ag-1"/>')).toBe("Stopping.");
    expect(streamingText('Stopping.\n<agent-stop to="ag')).toBe("Stopping.");
  });

  it("the sub-bot rule tells every engine's bot how to pull related workers into one sub bot", () => {
    expect(workerSubBotRule).toContain('subagents=\\"task_id,task_id\\"'.replaceAll("\\", ""));
    expect(workerSubBotRule).toContain("they keep running where they are");
  });
});
