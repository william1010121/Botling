import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import type { ChatState, MessageView, StepView } from "../src/types";

// jsdom has no ResizeObserver; the chat follows sizes with one.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

function message(overrides: Partial<MessageView>): MessageView {
  return {
    id: "m1", role: "bot", text: "", stamp: null, avatar: "data:image/png;base64,AA==",
    choices: null, chosen: null, answer: null, open: false, display: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
    ...overrides,
  };
}

const step = (id: string, title: string, extra: Partial<StepView> = {}): StepView =>
  ({ id, kind: "tool", tool: "Bash", title, detail: null, output: null, failed: false, done: true, status: null, count: null, ...extra });

/** A subagent's view as the app sends it: its task and a later message from its bot, its calls, its report. */
function watching(overrides: Partial<ChatState> = {}): ChatState {
  return {
    botID: "b1/toolu_A", botName: "Review PR #7", working: false, avatar: "", placeholder: "",
    replyingTo: null, pendingFiles: [], components: {},
    subagent: { id: "toolu_A", title: "Review PR #7", owner: "Main", status: "completed", type: "general-purpose", engine: "claude", model: "Sonnet" },
    messages: [
      message({ id: "a-task", role: "user", text: "Review the diff of PR #7.", speaker: "Main", time: "15:58", avatar: null }),
      message({ id: "a-1", text: "", steps: [
        step("s1", "Run git diff main...HEAD --stat", { detail: "git diff main...HEAD --stat", output: " 3 files changed, 40 insertions(+)" }),
        step("s2", "Read WebBotView.swift", { tool: "Read", detail: "/x/WebBotView.swift", output: "import SwiftUI\n…" }),
      ] }),
      message({ id: "a-2", role: "user", text: "Also check the sign-in store is per site.", speaker: "Main", time: "16:01", avatar: null }),
      message({ id: "a-result", text: "**No blocking issues.** The store is per site.", steps: [
        step("s3", "Run swift test --filter WebBot", { output: "Test run with 12 tests passed" }),
      ] }),
    ],
    ...overrides,
  };
}

const bar = () => document.getElementById("subagent-bar")!;
const lines = () => [...document.querySelectorAll<HTMLElement>("#messages .step.tool")];

beforeAll(async () => {
  document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
  await import("../src/main");
});

beforeEach(() => {
  sent.length = 0;
});

describe("a subagent's view", () => {
  it("identifies independent Codex workers without renaming native subagents", () => {
    const base = watching();
    window.ccb.setState({ ...base, subagent: { ...base.subagent!, engine: "codex", type: "codex-worker" } });
    expect(bar().querySelector(".engine-badge")?.textContent).toBe("Codex worker");
    expect(bar().querySelector(".meta")?.textContent).not.toContain("codex-worker");
    window.ccb.setState({ ...base, subagent: { ...base.subagent!, engine: "codex", type: "codex" } });
    expect(bar().querySelector(".engine-badge")?.textContent).toBe("Codex subagent");
  });

  it("heads it with the bot › the subagent, its engine and its model, and goes back by the bot", () => {
    window.ccb.setState(watching());
    expect(bar().querySelector(".crumb-owner")?.textContent).toBe("Main");
    expect(bar().querySelector(".title")?.textContent).toBe("Review PR #7");
    expect(bar().querySelector(".engine-badge")?.textContent).toBe("Claude subagent");
    expect(bar().querySelector(".engine-badge")?.classList.contains("claude")).toBe(true);
    expect(bar().querySelector(".meta")?.textContent).toContain("Sonnet");
    bar().querySelector<HTMLButtonElement>(".crumb-owner")!.click();
    expect(sent).toContainEqual({ type: "closeSubagent" });
  });

  it("shows captured effort and Fast for Codex while keeping model, status and watch only", () => {
    const state = watching();
    window.ccb.setState({ ...state, subagent: { ...state.subagent!, engine: "codex", type: "codex-worker",
      model: "gpt-6.1-sol", runtime: { reasoningEffort: "xhigh", serviceTier: "fast" } } });
    const meta = bar().querySelector<HTMLElement>(".meta")!;
    expect(meta.textContent).toContain("gpt-6.1-sol · Effort: xhigh · Fast: on");
    expect(meta.textContent).toContain("watch only");
    expect(meta.title).toContain("session settings");
    expect(bar().querySelector(".engine-badge")?.textContent).toBe("Codex worker");
  });

  it.each([
    ["priority", "on"], ["fast", "on"], ["default", "off"], ["flex", "off"],
    [null, "unknown"], ["auto", "unknown"], ["future-tier", "unknown"],
  ])("renders service tier %s as Fast %s", (serviceTier, expected) => {
    const state = watching();
    window.ccb.setState({ ...state, subagent: { ...state.subagent!, engine: "codex",
      runtime: { serviceTier } } });
    expect(bar().querySelector(".meta")?.textContent).toContain(`Fast: ${expected}`);
    expect(bar().querySelector(".meta")?.textContent).toContain("Effort: unknown");
  });

  it("keeps legacy data unknown and never shows Fast for Claude", () => {
    const state = watching();
    window.ccb.setState({ ...state, subagent: { ...state.subagent!, engine: "codex" } });
    expect(bar().querySelector(".meta")?.textContent).toContain("Effort: unknown · Fast: unknown");
    window.ccb.setState({ ...state, subagent: { ...state.subagent!, engine: "claude",
      runtime: { reasoningEffort: "high", serviceTier: "fast" } } });
    expect(bar().querySelector(".meta")?.textContent).toContain("Effort: high");
    expect(bar().querySelector(".meta")?.textContent).not.toContain("Fast:");
  });

  it("updates runtime values on the same worker header", () => {
    const state = watching();
    window.ccb.setState({ ...state, subagent: { ...state.subagent!, engine: "codex",
      runtime: { reasoningEffort: "high", serviceTier: "fast" } } });
    window.ccb.setState({ ...state, subagent: { ...state.subagent!, engine: "codex",
      runtime: { reasoningEffort: "low", serviceTier: "default" } } });
    expect(bar().querySelector(".meta")?.textContent).toContain("Effort: low · Fast: off");
  });

  it("has no input box, and gets it back on leaving", () => {
    window.ccb.setState(watching());
    expect(document.getElementById("composer-slot")!.hidden).toBe(true);
    expect(document.querySelector("#messages .reply-button")).toBeNull();
    window.ccb.setState({ ...watching(), botID: "b1", subagent: null, messages: [] });
    expect(document.getElementById("composer-slot")!.hidden).toBe(false);
    expect(document.getElementById("subagent-bar")).toBeNull();
  });

  it("shows what the bot sent it, in order, as boxes from the bot with their time", () => {
    window.ccb.setState(watching());
    const boxes = [...document.querySelectorAll<HTMLElement>("#messages .sub-from")];
    expect(boxes.map((box) => box.querySelector(".sub-from-label")?.textContent)).toEqual(["From Main · 15:58", "From Main · 16:01"]);
    expect(boxes.map((box) => box.querySelector(".sub-from-body")?.textContent?.trim())).toEqual([
      "Review the diff of PR #7.",
      "Also check the sign-in store is per site.",
    ]);
    // The second came after the first two calls, before the last one.
    const order = [...document.querySelectorAll<HTMLElement>("#messages .sub-from, #messages .step.tool")]
      .map((element) => element.classList.contains("sub-from") ? "from" : element.querySelector(".step-title")!.textContent);
    expect(order).toEqual(["from", "Run git diff main...HEAD --stat", "Read WebBotView.swift", "from", "Run swift test --filter WebBot"]);
    // No bubbles or faces: compact boxes.
    expect(document.querySelector("#messages .user-bubble")).toBeNull();
    expect(document.querySelector("#messages .avatar")).toBeNull();
  });

  it("folds each finished run of steps to one \"N steps\" line, and the one under way stays in sight", () => {
    const running = watching();
    window.ccb.setState({ ...running, working: true, subagent: { ...running.subagent!, status: "running" }, live: [step("s4", "Run swift build", { done: false })] });
    // One fold per finished run, between what it was sent and what it said, as in the main chat.
    const runs = [...document.querySelectorAll<HTMLElement>("#messages .sub-work:not(.live) .steps-run")];
    expect(runs.map((run) => run.querySelector(".steps-toggle")!.textContent)).toEqual(["2 steps", "1 step"]);
    for (const run of runs) {
      expect(run.querySelector(".steps-toggle")!.getAttribute("aria-expanded")).toBe("false");
      expect(run.querySelector<HTMLElement>(".step-list")!.hidden).toBe(true);
    }
    // The run under way is not folded: its step shows, spinning, with no typing bubble or face.
    const live = document.querySelector<HTMLElement>("#messages .sub-work.live")!;
    expect(live.querySelector(".steps-toggle")).toBeNull();
    const current = live.querySelector<HTMLElement>(".step.tool")!;
    expect(current.querySelector(".step-title")!.textContent).toBe("Run swift build");
    expect(current.closest("[hidden]")).toBeNull();
    expect(current.querySelector(".step-icon.spinner")).not.toBeNull();
    expect(document.querySelector("#messages .bubble.working")).toBeNull();
  });

  it("unfolds a run to its lines on a click, folds it again, and keeps it open over a redraw", () => {
    window.ccb.setState(watching());
    const first = () => document.querySelector<HTMLElement>("#messages .steps-run")!;
    first().querySelector<HTMLButtonElement>(".steps-toggle")!.click();
    expect(first().querySelector<HTMLElement>(".step-list")!.hidden).toBe(false);
    expect([...first().querySelectorAll(".step-title")].map((title) => title.textContent)).toEqual(["Run git diff main...HEAD --stat", "Read WebBotView.swift"]);
    window.ccb.setState(watching());
    expect(first().querySelector<HTMLElement>(".step-list")!.hidden).toBe(false);
    first().querySelector<HTMLButtonElement>(".steps-toggle")!.click();
    expect(first().querySelector<HTMLElement>(".step-list")!.hidden).toBe(true);
  });

  it("keeps a long run under way to its latest steps, with how many came before", () => {
    const running = watching();
    const many = Array.from({ length: 24 }, (_, index) => step(`l${index}`, `Read File${index}.swift`, { tool: "Read", done: index < 23 }));
    window.ccb.setState({ ...running, working: true, subagent: { ...running.subagent!, status: "running" }, live: many });
    const live = document.querySelector<HTMLElement>("#messages .sub-work.live")!;
    const shown = [...live.querySelectorAll(".step-title")].map((title) => title.textContent);
    expect(shown.length).toBeLessThan(many.length);
    expect(shown.at(-1)).toBe("Read File23.swift");
    expect(live.querySelector(".steps-earlier")!.textContent).toContain("24 steps");
  });

  it("keeps a command's output folded until its line is clicked, and folds it again", () => {
    window.ccb.setState(watching());
    for (const run of document.querySelectorAll<HTMLElement>("#messages .steps-run:not(.open)")) run.querySelector<HTMLButtonElement>(".steps-toggle")!.click();
    const line = lines()[0];
    const body = line.querySelector<HTMLElement>(".step-body")!;
    expect(body.hidden).toBe(true);
    line.querySelector<HTMLButtonElement>(".step-head")!.click();
    expect(body.hidden).toBe(false);
    expect(body.textContent).toContain("3 files changed");
    line.querySelector<HTMLButtonElement>(".step-head")!.click();
    expect(body.hidden).toBe(true);
    // A long read is folded the same way.
    expect(lines()[1].querySelector<HTMLElement>(".step-body")!.hidden).toBe(true);
  });

  it("ends with its report in prose, after its last step", () => {
    window.ccb.setState(watching());
    const report = [...document.querySelectorAll<HTMLElement>("#messages .sub-text")].pop()!;
    expect(report.querySelector("strong")?.textContent).toBe("No blocking issues.");
    const last = lines().pop()!;
    expect(last.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
