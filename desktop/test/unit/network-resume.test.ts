// 1.x's NetworkResume.swift, ported word for word (NetworkResumeTests).
import { describe, expect, it } from "vitest";
import { isConnectionError, isConnectionLoss, mentionsConnectionError, probeEndpoint, restoredText, resumeMode, resumeNote } from "../../src/core/network-resume";
import { parseLine } from "../../src/core/agent/stream";
import { tempDir } from "../helpers";

describe("network resume", () => {
  it("reads claude's API errors with no answer as the network, not refusals or HTTP errors", () => {
    expect(isConnectionLoss({ is_api_error_message: true, error: "unknown" })).toBe(true);
    expect(isConnectionLoss({ is_api_error_message: true, error: "server_error", api_error: "no_response" })).toBe(true);
    expect(isConnectionLoss({ is_api_error_message: true, error: "server_error", api_error_status: 529 })).toBe(false);
    expect(isConnectionLoss({ is_api_error_message: true, error: "invalid_request" })).toBe(false);
    expect(isConnectionLoss({ is_api_error_message: true, error: "unknown", api_error: "authentication" })).toBe(false);
    expect(parseLine(JSON.stringify({ type: "assistant", parent_tool_use_id: "toolu_1", is_api_error_message: true, message: { content: [] } }))).toEqual([{ kind: "connectionLost", parent: "toolu_1" }]);
    expect(parseLine(JSON.stringify({ type: "system", subtype: "api_retry", error_status: null, error: "connection_error" }))).toEqual([{ kind: "connectionTrouble" }]);
    expect(parseLine(JSON.stringify({ type: "system", subtype: "api_retry", error_status: 529, error: "overloaded" }))).toEqual([]);
  });

  it("knows claude's connection errors in words, not certificate problems", () => {
    expect(isConnectionError("API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)\nmore")).toBe(true);
    expect(isConnectionError("I looked at the connection error handling.\nAPI Error: Connection lost")).toBe(false);
    expect(mentionsConnectionError("warning\nAPI Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)")).toBe(true);
    expect(mentionsConnectionError("API Error: SSL certificate problem: network")).toBe(false);
  });

  it("carries on within 50 minutes; later, cut-off subagents start over with one line added", () => {
    const sub = [{ description: "Fix tests", type: "general-purpose", prompt: "Fix the failing tests", agentId: "a1b2" }];
    expect(resumeMode(10 * 60_000, 1)).toBe("carryOn");
    expect(restoredText(10 * 60_000, "carryOn")).toBe("網路恢復 · 中斷約 10 分鐘 · 接著原本的工作");
    expect(resumeNote(60_000, true, sub)).toBe("(App: 網路中斷: the network connection was lost about 1 minute ago and is back now.)\nCarry on with what you were doing when it dropped, from where you left off; do not start over or redo finished steps.\nThese subagents were cut off by it. Continue each one where it stopped by sending it a message with SendMessage (to: its agentId), so it keeps its context; only if it can no longer be reached, start a new one of the same type in the same worktree with its original prompt plus the line \"這個任務剛剛被中斷了，請從 worktree 的現況接著做\".\n- \"Fix tests\" (agentId: a1b2), subagent_type: general-purpose");
    expect(resumeMode(60 * 60_000, 1)).toBe("restartSubagents");
    expect(resumeNote(60 * 60_000, false, sub)).toBe("(App: 網路中斷: the network connection was lost about 60 minutes ago and is back now.)\nThese subagents were cut off more than 50 minutes ago, so do not continue them. Start each again as a NEW subagent of the same type, working in the same worktree it used (do not make a new one), with exactly the prompt given here (its original prompt with one line added at the end):\n- \"Fix tests\" (subagent_type: general-purpose):\n<prompt>\nFix the failing tests\n這個任務剛剛被中斷了，請從 worktree 的現況接著做\n</prompt>");
  });

  it("probes the API bots use: ANTHROPIC_BASE_URL, else Anthropic's", () => {
    const none = tempDir("probe");
    expect(probeEndpoint({}, none)).toBe("https://api.anthropic.com/");
    expect(probeEndpoint({ ANTHROPIC_BASE_URL: "https://gateway.example/v1" }, none)).toBe("https://gateway.example/v1");
    expect(probeEndpoint({ ANTHROPIC_BASE_URL: "ftp://nope" }, none)).toBe("https://api.anthropic.com/");
  });
});
