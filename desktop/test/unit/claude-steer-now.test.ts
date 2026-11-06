// A message of yours while claude works goes in with priority "now", so it takes effect at once; a foreground
// subagent at work is moved to the background first (`background_tasks`), as a "now" message would otherwise
// wait for it and then stop it (claude 2.1.318, checked live).
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ClaudeHead, type HeadConfig } from "../../src/core/agent/head";

const base: HeadConfig = { command: "claude", cwd: "/tmp", sessionId: "s", resume: false, allowedTools: [] };

function transport() {
  const writes: any[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.stdin.on("data", (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) writes.push(JSON.parse(line)); });
  const head = new ClaudeHead(base, { onItem() {}, onExit() {} },
    { platform: "test", verified: true, spawn: () => ({ pid: 1, child, terminate: async () => ({ killed: [], forced: false }) }) } as any);
  head.start();
  const receive = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  // Its tool policy registered (the Monitor hook's initialize): input goes straight in from here on.
  const init = writes.splice(0).find((w) => w.request?.subtype === "initialize");
  if (init) receive({ type: "control_response", response: { subtype: "success", request_id: init.request_id, response: {} } });
  return { head, writes, receive, settle };
}
const agentCall = (id: string, input: Record<string, unknown> = {}, parent: string | null = null) =>
  ({ type: "assistant", parent_tool_use_id: parent, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input: { prompt: "p", ...input } }] } });
const toolResult = (id: string) => ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "done" }] } });

describe("a message sent now", () => {
  it("backgrounds the foreground subagent at work, then goes in with priority now", async () => {
    const t = transport();
    t.receive(agentCall("toolu_A"));
    await t.settle();
    t.head.send("stop that", "U2", [], { now: true });
    expect(t.writes).toHaveLength(2);
    expect(t.writes[0]).toMatchObject({ type: "control_request", request: { subtype: "background_tasks", tool_use_id: "toolu_A" } });
    expect(t.writes[1]).toMatchObject({ type: "user", uuid: "u2", priority: "now", message: { content: "stop that" } });
  });
  it("backgrounds nothing for a subagent already in the background, one that finished, or one a subagent started", async () => {
    const t = transport();
    t.receive(agentCall("toolu_B", { run_in_background: true }));
    t.receive(agentCall("toolu_C"));
    t.receive(toolResult("toolu_C"));
    t.receive(agentCall("toolu_D", {}, "toolu_X"));
    await t.settle();
    t.head.send("hi", "u3", [], { now: true });
    expect(t.writes).toEqual([expect.objectContaining({ type: "user", uuid: "u3", priority: "now" })]);
  });
  it("forgets the subagents of a turn that ended, and of one it moved to the background already", async () => {
    const t = transport();
    t.receive(agentCall("toolu_E"));
    await t.settle();
    t.head.send("one", "u4", [], { now: true });
    t.head.send("two", "u5", [], { now: true });
    expect(t.writes.filter((w) => w.type === "control_request")).toHaveLength(1);
    t.receive(agentCall("toolu_F"));
    t.receive({ type: "result", subtype: "success", result: "" });
    await t.settle();
    t.head.send("three", "u6", [], { now: true });
    expect(t.writes.filter((w) => w.type === "control_request")).toHaveLength(1);
  });
  it("leaves an ordinary message as it was: no priority, nothing backgrounded", async () => {
    const t = transport();
    t.receive(agentCall("toolu_G"));
    await t.settle();
    t.head.send("next", "u7");
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0].priority).toBeUndefined();
  });
});
