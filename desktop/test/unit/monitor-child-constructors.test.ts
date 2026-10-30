import { afterEach, expect, it, vi } from "vitest";
import { ClaudeHead, type HeadConfig } from "../../src/core/agent/head";
import { TeamDesk, DEFAULT_TEAMS } from "../../src/core/teams";
import { briefConfig, writeBrief } from "../../src/core/component-brief";
import { tempDir } from "../helpers";
const base: HeadConfig = { command: "/never-launch", cwd: "/tmp", sessionId: "owner", resume: false, allowedTools: ["Monitor"], monitorWorker: false };
const heads: ClaudeHead[] = [];
function mockTransport() {
  vi.spyOn(ClaudeHead.prototype, "start").mockImplementation(function(this: ClaudeHead) { heads.push(this); });
  vi.spyOn(ClaudeHead.prototype, "send").mockImplementation(() => {});
  vi.spyOn(ClaudeHead.prototype, "terminate").mockResolvedValue({ killed: [], forced: false });
}
function decision(head: ClaudeHead) {
  const write = vi.spyOn(head as any, "write").mockImplementation(() => {});
  (head as any).line(JSON.stringify({ type: "control_request", request_id: "h", request: { subtype: "hook_callback", callback_id: "botling-monitor-owner",
    input: { hook_event_name: "PreToolUse", tool_name: "Monitor", tool_input: { command: "echo intent" } } } }));
  return (write.mock.calls.at(-1)![0] as any).response.response;
}
afterEach(() => { heads.length = 0; vi.restoreAllMocks(); });
it("standalone teams override inherited coordinator identity before any Monitor hook", async () => {
  mockTransport();
  const desk = new TeamDesk({ root: tempDir("monitor-team"), config: () => ({ ...base }), language: () => "en", results: () => "local",
    teams: () => [{ ...DEFAULT_TEAMS[0], tools: ["Monitor"] }], tell() {}, changed() {}, log() {} } as any);
  try {
    expect(desk.start(DEFAULT_TEAMS[0].name, "authorized task")).not.toBeNull();
    expect(heads[0].config.monitorWorker).toBe(true);
    expect(decision(heads[0])).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  } finally { await desk.shutdown(); }
});
it("component brief factory and direct writer both classify the fork as a child", async () => {
  mockTransport();
  expect(briefConfig(base).monitorWorker).toBe(true);
  const done = writeBrief(base, "brief");
  try {
    expect(heads[0].config.monitorWorker).toBe(true);
    expect(decision(heads[0])).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  } finally { (heads[0] as any).handlers.onItem({ kind: "result", ok: true, text: "brief" }); await done; }
});
it("missing head ownership fails closed; an explicitly trusted coordinator keeps its normal permissions", () => {
  const handlers = { onItem() {}, onExit() {} };
  expect(decision(new ClaudeHead({ ...base, monitorWorker: undefined }, handlers))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(decision(new ClaudeHead(base, handlers))).toEqual({});
});

import { Bot } from "../../src/core/bot";
import { mainProfile } from "../../src/core/store/workspace";
import { ProcessLedger } from "../../src/core/process/ledger";
import { botPrompts } from "../../src/core/prompts";
import { CodexHead, CodexThreads } from "../../src/core/agent/codex";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
it("the actual bot coordinator constructor explicitly retains monitor eligibility", async () => {
  mockTransport();
  const dir = tempDir("monitor-coordinator"), profile = mainProfile(dir);
  mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: "claude" }));
  const bot = new Bot({ profile, deferStartup: true, welcome: false, ledger: new ProcessLedger(join(dir, "ledger.json")),
    headConfig: () => ({ ...base, monitorWorker: undefined }), prompts: () => botPrompts({ profile, engine: "claude" }),
    emit() {}, log() {}, approvalTimeoutMs: 60000, idleMs: 60000, interruptGraceMs: 1 });
  try {
    bot.send("already authorized task");
    // The turn is handed to the agent right after chat.send has answered (Bot.begin), not inside it.
    await new Promise((resolve) => setImmediate(resolve));
    expect(heads[0].config.monitorWorker).toBe(false);
    expect(decision(heads[0])).toEqual({});
  } finally { for (const head of heads) head.running = false; await bot.shutdown({ tidy: false }); }
});
it("the component-editor transport overrides a coordinator-marked launch configuration", () => {
  mockTransport();
  const root = tempDir("monitor-editor");
  const transport = new CodexHead({ command: "/never-launch", cwd: root, sessionId: "owner", resume: false,
    instructions: "coordinator", workerInstructions: "worker", threads: new CodexThreads(join(root, "threads")) }, { onItem() {}, onExit() {} });
  (transport as any).performEditor({ kind: "start", task: "child", run: 1, config: base, text: "authorized edit" });
  expect(heads[0].config.monitorWorker).toBe(true);
  expect(decision(heads[0])).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
});
