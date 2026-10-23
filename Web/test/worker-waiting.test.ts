import { beforeAll, describe, expect, it } from "vitest";
import type { ChatState, MessageView, StepView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const worker = (status = "running"): StepView => ({
  id: "worker-session", kind: "subagent", title: "Check protocol", tool: "app_start_worker", detail: null,
  output: null, failed: false, done: status !== "running", status, count: 2,
});
const reply = (status = "running"): MessageView => ({
  id: "delegated", role: "bot", text: "Started the worker.", stamp: null, avatar: null, choices: null,
  chosen: null, answer: null, open: false, attachments: null, replyTo: null, replyPreview: null,
  openable: false, steps: [worker(status)],
});
const state = (extra: Partial<ChatState> = {}): ChatState => ({
  botID: "worker-waiting", botName: "Codex", messages: [reply()], working: false, waitingForWorkers: true,
  avatar: "codex-avatar", placeholder: "Message Codex…", replyingTo: null, pendingFiles: [], components: {}, ...extra,
});

beforeAll(async () => {
  document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
  await import("../src/main");
});

describe("independent worker cards", () => {
  it("shows a static wait label while the coordinator is idle and preserves cards through chatting", () => {
    window.ccb.setState(state());
    expect(document.querySelector(".worker-waiting")?.textContent).toBe("Waiting for workers · You can keep chatting");
    expect(document.querySelector(".typing, .dots")).toBeNull();
    expect(document.querySelector(".subagent-card .subagent-title")?.textContent).toBe("Check protocol");
    const card = document.querySelector(".subagent-card");

    window.ccb.setState(state({ working: true }));
    expect(document.querySelector(".worker-waiting")).toBeNull();
    expect(document.querySelector(".typing .dots")).not.toBeNull();
    expect(document.querySelector(".subagent-card")).toBe(card);

    window.ccb.setState(state());
    expect(document.querySelector(".typing, .dots")).toBeNull();
    expect(document.querySelector(".worker-waiting")).not.toBeNull();
    expect(document.querySelector(".subagent-card")).toBe(card);

    window.ccb.setState(state({ waitingForWorkers: false, messages: [reply("completed")] }));
    expect(document.querySelector(".worker-waiting, .typing, .dots")).toBeNull();
    expect(document.querySelectorAll(".step-list:not([hidden]) .subagent-card")).toHaveLength(1);
  });

  it("does not leak the wait label into another chat or a worker detail view", () => {
    window.ccb.setState(state());
    window.ccb.setState(state({ botID: "other-chat", waitingForWorkers: false, messages: [] }));
    expect(document.querySelector(".worker-waiting")).toBeNull();
    window.ccb.setState(state({ subagent: { id: "worker-session", title: "Check protocol", owner: "Codex", status: "running", type: "codex", engine: "codex" } }));
    expect(document.querySelector(".worker-waiting")).toBeNull();
  });
});
