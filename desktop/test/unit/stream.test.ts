// Reading claude's stream-json lines (the head's parser), and the per-turn runner Phase 0 kept.
import { describe, expect, it } from "vitest";
import { ReplyText, parseLine, permissionSummary } from "../../src/core/agent/stream";
import { headArguments } from "../../src/core/agent/head";
import { AgentTurn, type TurnOutcome } from "../../src/core/agent/runner";
import { fakeCli, tempDir, until } from "../helpers";

describe("stream-json lines", () => {
  it("reads deltas, tool calls and results, permission requests and their cancellation", () => {
    expect(parseLine(`{"type":"system","subtype":"init","session_id":"s1"}`)).toEqual([{ kind: "init", sessionId: "s1" }]);
    expect(parseLine(`{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}`)).toEqual([{ kind: "delta", text: "Hi" }]);
    expect(parseLine(`{"type":"stream_event","parent_tool_use_id":"toolu_9","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"sub"}}}`)).toEqual([]);
    expect(parseLine(`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/a/b/notes.md"}}]}}`))
      .toEqual([{ kind: "toolUse", id: "t1", tool: "Read", title: "Read notes.md", detail: "/a/b/notes.md", parent: null }]);
    expect(parseLine(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"ok"}],"is_error":true}]}}`))
      .toEqual([{ kind: "toolResult", id: "t1", output: "ok", failed: true }]);
    expect(parseLine(`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf build","description":"Clean"}}}`))
      .toEqual([{ kind: "permission", requestId: "r1", tool: "Bash", summary: "rm -rf build", input: { command: "rm -rf build", description: "Clean" } }]);
    expect(parseLine(`{"type":"control_request","request_id":"r2","request":{"subtype":"hook_callback"}}`)).toEqual([{ kind: "unsupportedRequest", requestId: "r2", subtype: "hook_callback" }]);
    expect(parseLine(`{"type":"control_cancel_request","request_id":"r1"}`)).toEqual([{ kind: "permissionCancelled", requestId: "r1" }]);
    expect(parseLine(`{"type":"result","subtype":"error_during_execution","is_error":true,"result":""}`)[0]).toMatchObject({ kind: "result", ok: false });
    expect(parseLine("not json")).toEqual([]);
  });

  it("shows what will run, not the model's description of it", () => {
    expect(permissionSummary("WebFetch", { url: "https://x.test", prompt: "read" })).toBe("https://x.test");
    expect(permissionSummary("Thing", {}, "Does a thing")).toBe("Does a thing");
    expect(permissionSummary("Bash", { command: "x".repeat(2_100) })).toMatch(/2100 characters in all/);
  });

  it("builds the reply from deltas, with a paragraph after a tool call; whole messages only without deltas", () => {
    const reply = new ReplyText();
    reply.add({ kind: "delta", text: "Let me look. " });
    reply.add({ kind: "assistantText", text: "Let me look. " });
    reply.add({ kind: "textBlock" });
    reply.add({ kind: "delta", text: "Found it." });
    expect(reply.text).toBe("Let me look. \n\nFound it.");
    const whole = new ReplyText();
    whole.add({ kind: "assistantText", text: "One." });
    whole.add({ kind: "assistantText", text: "Two." });
    expect(whole.text).toBe("One.\n\nTwo.");
  });

  it("asks for approvals on stdio, and keeps harmless runs harmless", () => {
    const args = headArguments({ command: "claude", cwd: "/", sessionId: "s", resume: true, allowedTools: ["Read", "Bash"], systemPrompt: "You are X." });
    expect(args).toEqual(expect.arrayContaining(["--resume", "s", "--permission-prompt-tool", "stdio", "--allowedTools", "Read,Bash", "--append-system-prompt", "You are X.", "--permission-mode", "acceptEdits"]));
    const harmless = headArguments({ command: "claude", cwd: "/", sessionId: "s", resume: false, allowedTools: ["Read", "Bash"], harmless: true, harmlessTools: ["Bash"] });
    expect(harmless).toEqual(expect.arrayContaining(["--safe-mode", "--no-session-persistence", "--strict-mcp-config", "--tools", "Bash", "--permission-mode", "default"]));
    expect(harmless).not.toContain("--allowedTools");
    expect(harmless).not.toContain("--append-system-prompt");
  });
});

describe("the per-turn runner (Phase 0)", () => {
  it("still runs one print-mode turn with the per-turn fake CLI", async () => {
    let text = "";
    let outcome: TurnOutcome | null = null;
    const turn = new AgentTurn({ command: process.execPath, prefixArgs: [fakeCli], cwd: tempDir("turn") }, {
      onDelta: (piece) => { text += piece; },
      onFinish: (result) => { outcome = result; },
    });
    turn.start("per turn");
    await until(() => outcome);
    expect(outcome).toEqual({ status: "done", text: "You said: per turn" });
    expect(text).toBe("You said: per turn");
  });
});
