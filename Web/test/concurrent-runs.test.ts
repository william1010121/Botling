import { beforeAll, describe, expect, it } from "vitest";
import { chatState } from "../../desktop/src/renderer/payload";
import { WorkspaceStore } from "../../desktop/src/renderer/store";
import type { BotView, EventEnvelope, ResultOf } from "../../desktop/src/contract";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const bot: BotView = { id: "B", name: "Pair", role: "main", avatar: "circle", folder: "/w", phase: "awake", working: true, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude", "codex"], job: null, subagentRows: [] };
beforeAll(async () => {
  document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
  await import("../src/main");
});

describe("concurrent engine output through events, payload and chat DOM", () => {
  it.each((["done", "failed", "stopped"] as const).flatMap(status => ["a", "b"].map(ended => ({ status, ended }))))("keeps the peer live when $ended is $status", async ({ status, ended }) => {
    const survivor = ended === "a" ? "b" : "a";
    let seq = 0;
    let snapshot = { epoch: "e", seq, bots: [bot], imported: null, components: {}, plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null },
      chat: { botId: "B", messages: [], running: null, live: [], tasks: [], runs: [], heads: null, catchUp: null, intervalSummaries: [], pins: [], floating: [], pinChoices: [] } } as ResultOf<"chat.snapshot">;
    const store = new WorkspaceStore(async () => snapshot);
    await store.resync();
    const draw = () => window.ccb.setState(chatState(bot, store.getView().chat!).state);
    const send = (event: EventEnvelope["event"]) => {
      const envelope = { v: 10 as const, epoch: "e", seq: ++seq, event };
      store.receive(envelope); draw(); return envelope;
    };
    const step = (title: string) => [{ id: title, kind: "tool" as const, title, tool: "Bash", detail: null, output: null, failed: false, done: false }];
    for (const [id, head] of [["a", "claude"], ["b", "codex"]] as const) {
      send({ type: "turn.started", botId: "B", turnId: id, messageId: `m${id}`, head });
      send({ type: "turn.steps", botId: "B", turnId: id, messageId: `m${id}`, steps: step(`Work ${head}`) });
    }
    expect(document.querySelectorAll(".typing")).toHaveLength(2);
    expect(document.querySelector('[data-run-id="a"] .live-run-label')?.textContent).toBe("Pair · Claude");
    expect(document.querySelector('[data-run-id="b"] .live-run-label')?.textContent).toBe("Pair · Codex");
    window.ccb.setState(chatState({ ...bot, codexRetry: { attempt: 1, max: 5, reason: "rateLimited", retryAt: null } }, store.getView().chat!).state);
    expect(document.querySelector('[data-run-id="a"] .retry-note')).toBeNull();
    expect(document.querySelector('[data-run-id="b"] .retry-note')?.textContent).toContain("retrying");
    draw();
    expect(document.querySelector('[data-run-id="a"]')?.textContent).toContain("Work claude");
    expect(document.querySelector('[data-run-id="b"]')?.textContent).toContain("Work codex");
    const second = document.querySelector(`[data-run-id="${survivor}"]`);
    for (const [id, engine] of [["a", "claude"], ["b", "codex"]] as const) {
      send({ type: "message.added", botId: "B", message: { id: `m${id}`, role: "bot", text: "", time: "2026-10-29T08:00:00Z", engine, state: "streaming", turnId: id } });
    }
    send({ type: "turn.delta", botId: "B", turnId: "b", messageId: "mb", text: "Second output" });
    send({ type: "turn.delta", botId: "B", turnId: "a", messageId: "ma", text: "First output" });
    expect(document.getElementById("messages")?.textContent).toContain("Second output");
    const finish = send({ type: "turn.finished", botId: "B", turnId: ended, messageId: `m${ended}`, text: ended === "a" ? "First final" : "Second final", status });
    store.receive(finish); draw();
    expect(document.querySelectorAll(".typing")).toHaveLength(1);
    expect(document.querySelector(`[data-run-id="${survivor}"]`)).toBe(second);
    send({ type: "turn.steps", botId: "B", turnId: survivor, messageId: `m${survivor}`, steps: step("Still working") });
    expect(document.getElementById("messages")?.textContent).toContain("Still working");
    expect(store.getView().chat!.messages.map(m => [m.id, m.text])).toEqual([["ma", ended === "a" ? "First final" : "First output"], ["mb", ended === "b" ? "Second final" : "Second output"]]);
    snapshot = { ...snapshot, seq, chat: { ...snapshot.chat!, ...store.getView().chat! } } as typeof snapshot;
    await store.resync(); draw();
    expect(document.querySelectorAll(".typing")).toHaveLength(1);
    expect(document.getElementById("messages")?.textContent).toContain(ended === "a" ? "Second output" : "First output");
    send({ type: "turn.finished", botId: "B", turnId: survivor, messageId: `m${survivor}`, text: survivor === "a" ? "First final" : "Second final", status: "done" });
    expect(document.querySelectorAll(".typing")).toHaveLength(0);
    const text = document.getElementById("messages")!.textContent!;
    expect(text.match(/First final/g)).toHaveLength(1);
    expect(text.match(/Second final/g)).toHaveLength(1);
    expect(text.indexOf("First final")).toBeLessThan(text.indexOf("Second final"));
    expect(store.getView().chat!.messages.map(m => m.text)).toEqual(["First final", "Second final"]);
  });
});
