// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ResultOf } from "../../src/contract";
import { Bot } from "../../src/core/bot";
import { ProcessLedger } from "../../src/core/process/ledger";
import { mainProfile } from "../../src/core/store/workspace";
import { App } from "../../src/renderer/App";
import { Client } from "../../src/renderer/client";
import { WorkspaceStore } from "../../src/renderer/store";
import { subagentState } from "../../src/renderer/payload";
import { tempDir } from "../helpers";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

function owner() {
  const dir = tempDir("task-agents-ui");
  const profile = mainProfile(dir);
  mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "tasks.json"), JSON.stringify([
    { id: "task-card", name: "Parser task", state: "running", createdAt: 1, updatedAt: 2, messageIDs: [], kept: true, subagentIDs: ["claude-call", "worker-id", "missing-record"] },
    { id: "other-card", name: "Other task", state: "done", createdAt: 1, updatedAt: 2, messageIDs: [], kept: true, subagentIDs: ["unrelated"] },
    { id: "legacy-card", name: "Old task", state: "done", stateFromTag: "done", createdAt: 1, updatedAt: 2, messageIDs: [], kept: true },
    { id: "empty-card", name: "No agents yet", state: "done", createdAt: 1, updatedAt: 2, messageIDs: [], kept: true, subagentIDs: [], declared: true },
  ]));
  const bot = new Bot({ profile, deferStartup: true, welcome: false, ledger: new ProcessLedger(join(dir, "ledger.json")), headConfig() { throw new Error("No real CLI"); }, prompts() { throw new Error("No turn"); }, emit() {}, log() {}, approvalTimeoutMs: 100, idleMs: 100, interruptGraceMs: 100 });
  bot.subagents.list.push(
    { id: "claude-call", description: "API research", prompt: "Look up API", status: "completed", type: "general-purpose", background: true, startedAt: 1, endedAt: 2, steps: [], result: "Found the API" },
    { id: "worker-id", description: "Build parser", prompt: "Implement the parser", status: "running", type: "codex-worker", background: true, startedAt: 1, steps: [], execution: { run: 2, ownerSessionId: "owner-session", threadId: "actual-thread", turnId: "actual-turn" } },
    { id: "unrelated", description: "Unrelated", prompt: "Other work", status: "running", background: true, startedAt: 1, steps: [] },
  );
  return bot;
}

describe("task card to actual subagent details", () => {
  it("clicks through App's real command path using the worker id, shows its own session, and receives live changes", async () => {
    const bot = owner();
    const snapshot = (): ResultOf<"chat.snapshot"> => ({ epoch: "test", seq: 0, bots: [bot.view()], imported: null, chat: bot.snapshot(), components: {}, plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null } });
    const store = new WorkspaceStore(async () => snapshot());
    await store.resync();
    const commands: any[] = [];
    let receive: (value: unknown) => void = () => {};
    const client = new Client({ protocol: PROTOCOL_VERSION, subscribe(listener) { receive = listener; return () => {}; }, post(envelope: any) {
      commands.push(envelope.cmd);
      const result = envelope.cmd.type === "subagent.view" ? bot.subagentView(envelope.cmd.subagentId) : {};
      queueMicrotask(() => receive({ v: PROTOCOL_VERSION, id: envelope.id, ok: true, result }));
    } });
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () => root.render(createElement(App, { client, store })));
      const card = host.querySelector('[data-task="task-card"].task-card')!;
      expect(card.textContent).toContain("1 active");
      expect(card.querySelectorAll("button.task-agent")).toHaveLength(2);
      expect(card.querySelector('[data-agent="unrelated"]')).toBeNull();
      expect(card.querySelector('[data-agent="missing-record"]')?.tagName).toBe("DIV");
      expect(card.querySelector('[data-agent="worker-id"]')?.textContent).toBe("Build parserCodex · running↗");
      await act(async () => card.querySelector<HTMLButtonElement>('[data-agent="worker-id"]')!.click());
      expect(commands.find((cmd) => cmd.type === "subagent.view")).toEqual({ type: "subagent.view", botId: bot.id, subagentId: "worker-id" });
      expect(store.getView().subagent).toMatchObject({ id: "worker-id", prompt: "Implement the parser", execution: { threadId: "actual-thread", turnId: "actual-turn" } });
      expect(subagentState(bot.view(), store.getView().subagent!).state.messages[0].text).toBe("Implement the parser"); // No ids or threads, just its task.
      // A real core event updates both the open details and task status; a snapshot retains links.
      const worker = bot.subagents.get("worker-id")!;
      worker.status = "completed"; worker.result = "Parser built"; worker.endedAt = 3;
      await act(async () => {
        store.receive({ v: PROTOCOL_VERSION, epoch: "test", seq: 1, event: { type: "subagent.updated", botId: bot.id, subagent: bot.subagentView(worker.id).subagent } });
        store.receive({ v: PROTOCOL_VERSION, epoch: "test", seq: 2, event: { type: "tasks.updated", botId: bot.id, tasks: bot.taskViews() } });
      });
      expect(store.getView().subagent).toMatchObject({ status: "completed", result: "Parser built" });
      expect(host.querySelector('[data-task="task-card"] [data-agent="worker-id"]')?.textContent).toContain("completed");
      await act(async () => store.resync());
      expect(store.getView().chat!.tasks[0].relatedAgents?.map((agent) => agent.id)).toEqual(["claude-call", "worker-id", "missing-record"]);
      await act(async () => host.querySelector<HTMLButtonElement>('[data-task="task-card"] [data-agent="claude-call"]')!.click());
      expect(store.getView().subagent).toMatchObject({ id: "claude-call", result: "Found the API", engine: "claude" });
    } finally {
      await act(async () => root.unmount()); host.remove();
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it("shows nothing at all for a task with no related subagents, recorded or not", async () => {
    const { RightPanel } = await import("../../src/renderer/RightPanel");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const bot = owner();
    for (const id of ["legacy-card", "empty-card"]) {
      const markup = renderToStaticMarkup(createElement(RightPanel, {
        bot: bot.view(), bots: [bot.view()], waiting: { items: [], doing: {} }, look: "original", status: { key: "awake", text: "Idle" }, results: [], teams: [], watching: null, tasks: bot.taskViews(), messages: [], selectedTask: id, collapsed: false,
        onSelectTask() {}, onJumpToTask() {}, onAskForReport() {}, onCompleteTask() {}, onEditGroup() {}, onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent() {}, onUnsettle() {}, onSettings() {}, onExpand() {},
      }));
      expect(markup).toContain("task-card");
      expect(markup).not.toContain("task-agents");
      expect(markup).not.toMatch(/subagent/i);
    }
  });
});
