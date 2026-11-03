// @vitest-environment jsdom
/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { componentElement, keepFrames } from "../../../../Web/src/components";
import { mediaHTML } from "../../../../Web/src/markdown";
import type { ComponentInfo, SpecState } from "../src/types";
import { SpecPanel, type PanelIO } from "../src/panel";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const components: Record<string, ComponentInfo> = {
  網頁預覽卡片: { template: "<div>page</div>", version: 1, working: false, updated: false, hasPrevious: false },
  "test-summary": { template: "<div>tests</div>", version: 1, working: false, updated: false, hasPrevious: false },
};

function spec(overrides: Partial<SpecState> = {}): SpecState {
  return {
    id: "S1", name: "test-summary", about: "Test results", status: "draft", draft: 2,
    chat: "ClaudeCodeBot", from: "from ClaudeCodeBot's reply at 22:14", suggestedBy: null, existing: null,
    fields: [{ name: "total", type: "int", by: "app" }, { name: "failures", type: "[suite, test]", by: "maintainer" }],
    command: "swift test --parallel", folder: "/Users/me/ClaudeCodeBot",
    refresh: "manual", minutes: 15,
    bots: [{ name: "ClaudeCodeBot", on: true }, { name: "Arbor", on: false }],
    similar: "build-status", similarAbout: "Whether the last build passed.", reuse: false,
    samples: [{ label: "This reply", kind: "reply", data: '{"total":382}' }, { label: "Failing run", kind: null, data: '{"total":382,"failed":2}' }],
    preferredSample: 0,
    questions: [{ id: "q1", text: "How often?", options: [{ label: "Only on ↻" }, { label: "Every show" }], suggested: 0 }],
    conversation: [{ kind: "maintainer", text: "其他欄位我照這則回覆填好了。" }, { kind: "event", text: "You edited Command" }],
    origins: { command: "user", refresh: "maintainer" },
    preview: null, components, testRun: null, steps: null, wide: false,
    ...overrides,
  };
}

const click = (element: Element | null | undefined) => (element as HTMLElement).click();

/** What the panel asked of its plugin (`PanelIO`), in the order it asked: the method and what it passed. */
const calls: Record<string, unknown>[] = [];
const io: PanelIO = {
  act: (method, params = {}) => { calls.push({ method, ...params }); },
  testRun: (id, command, folder) => { calls.push({ method: "testRun", id, command, folder }); },
  // The page's own drawing, as `ccb.draw` lends it.
  preview: (name, info, data, key) => componentElement(name, info, data, null, key),
  keepFrames: (old, fresh) => keepFrames(old, fresh),
  media: (url, label) => mediaHTML(url, label),
  mediaClicks: () => {},
};

beforeEach(() => {
  calls.length = 0;
  document.body.innerHTML = "";
  document.documentElement.lang = "en";
});

describe("the spec workspace in the right panel", () => {
  function panel(state: SpecState): HTMLElement {
    document.body.innerHTML = `<div id="panel-root"></div>`;
    const root = document.getElementById("panel-root")!;
    new SpecPanel(root, io).update(state);
    return root;
  }

  it("shows a preview with switchable sample data", () => {
    const root = panel(spec());
    const tabs = [...root.querySelectorAll(".spec-samples button")];
    expect(tabs.map((t) => t.textContent)).toEqual(["This reply", "Failing run"]);
    expect(tabs[0].getAttribute("aria-pressed")).toBe("true");
    // No template yet: a plain drawing of the data.
    const frame = root.querySelector<HTMLIFrameElement>(".spec-preview iframe")!;
    expect(frame.srcdoc).toContain('{"total":382}');
    click(tabs[1]);
    expect(root.querySelector<HTMLIFrameElement>(".spec-preview iframe")!.srcdoc).toContain('"failed":2');
    expect(root.querySelector(".spec-samples button[aria-pressed='true']")?.textContent).toBe("Failing run");
  });

  it("a built component without a command previews with the reply's own data", () => {
    const samples: SpecState["samples"] = [
      { label: "Failing run", kind: null, data: '{"total":382,"failed":2}' },
      { label: "Test run", kind: "testRun", data: '"# Changelog"' },
      { label: "This reply", kind: "reply", data: '{"versions":["1.9.0 看板變成格子"]}' },
    ];
    const root = panel(spec({ status: "done", preview: "test-summary", command: null, samples, preferredSample: 2, questions: [] }));
    expect(root.querySelector(".spec-samples button[aria-pressed='true']")?.textContent).toBe("This reply");
    expect(root.querySelector<HTMLIFrameElement>(".spec-preview iframe")!.srcdoc).toContain("看板變成格子");
    // With a command (live data), the real run comes first.
    const live = panel(spec({ id: "S2", status: "done", preview: "test-summary", samples, preferredSample: 1, questions: [] }));
    expect(live.querySelector(".spec-samples button[aria-pressed='true']")?.textContent).toBe("Test run");
  });

  it("which sample shows first is the app's pick, not a label it recognizes", () => {
    // Translated labels, and a sample of Maintainer's that only reads like the app's.
    const samples: SpecState["samples"] = [
      { label: "This reply", kind: null, data: '{"total":1}' },
      { label: "這則回覆", kind: "reply", data: '{"total":2}' },
    ];
    const root = panel(spec({ samples, preferredSample: 1 }));
    const tabs = [...root.querySelectorAll(".spec-samples button")];
    expect(tabs.map((t) => t.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(root.querySelector<HTMLIFrameElement>(".spec-preview iframe")!.srcdoc).toContain('{"total":2}');
    // Picking one keeps it.
    click(tabs[0]);
    expect([...root.querySelectorAll(".spec-samples button")].map((t) => t.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  });

  it("a built or existing component previews with its own template", () => {
    const root = panel(spec({ preview: "test-summary" }));
    expect(root.querySelector<HTMLIFrameElement>(".spec-preview iframe")!.srcdoc).toContain("<div>tests</div>");
  });

  it("marks your edits blue and Maintainer's purple", () => {
    const root = panel(spec());
    expect(root.querySelector("[data-key='command']")!.closest(".spec-field")!.classList.contains("by-user")).toBe(true);
    expect(root.querySelector("[data-key='refresh']")!.closest(".spec-field")!.classList.contains("by-maintainer")).toBe(true);
    const chips = [...root.querySelectorAll(".spec-data .spec-datum")];
    expect(chips[1].classList.contains("by-maintainer")).toBe(true);
    expect(chips[0].classList.contains("by-maintainer")).toBe(false);
  });

  it("field edits go back as edits", () => {
    const root = panel(spec());
    const command = root.querySelector<HTMLInputElement>("input[data-key='command']")!;
    command.value = "swift test --skip-build";
    command.dispatchEvent(new Event("change"));
    expect(calls).toEqual([{ method: "edit", id: "S1", key: "command", value: "swift test --skip-build" }]);
    calls.length = 0;
    click([...root.querySelectorAll(".spec-refresh button")].find((b) => b.textContent === "When shown"));
    expect(calls).toEqual([{ method: "edit", id: "S1", key: "refresh", value: "shown" }]);
    calls.length = 0;
    click([...root.querySelectorAll(".spec-bots button")].find((b) => b.textContent?.includes("Arbor")));
    expect(calls).toEqual([{ method: "edit", id: "S1", key: "bots", value: "ClaudeCodeBot, Arbor" }]);
    calls.length = 0;
    click(root.querySelector(".spec-similar button.reuse"));
    expect(calls).toEqual([{ method: "edit", id: "S1", key: "reuse", value: "true" }]);
  });

  it("Maintainer's questions come with suggested answers", () => {
    const root = panel(spec());
    const answers = [...root.querySelectorAll(".spec-question button")];
    expect(answers.map((a) => a.textContent)).toEqual(["Only on ↻ · suggested", "Every show"]);
    click(answers[1]);
    expect(calls).toEqual([{ method: "answer", id: "S1", question: "q1", option: 1 }]);
  });

  it("the side conversation and Anything to add", () => {
    const root = panel(spec());
    expect(root.querySelector(".spec-line.maintainer")?.textContent).toContain("其他欄位");
    expect(root.querySelector(".spec-line.event")?.textContent).toContain("You edited Command");
    const box = root.querySelector<HTMLTextAreaElement>(".spec-say textarea")!;
    expect(box.placeholder).toContain("Anything to add?");
    box.value = "失敗的要列名字";
    click(root.querySelector(".spec-say button"));
    expect(calls).toEqual([{ method: "say", id: "S1", text: "失敗的要列名字" }]);
  });

  it("a contact sheet in Maintainer's words shows under them as a picture", () => {
    const root = panel(spec({ conversation: [{ kind: "maintainer", text: "Checked it on every surface.", images: ["file:///tmp/shot/contact-sheet.png"] }] }));
    const line = root.querySelector(".spec-line.maintainer .spec-words")!;
    expect(line.textContent).toContain("Checked it on every surface.");
    const picture = line.querySelector<HTMLImageElement>("img.media")!;
    expect(picture.getAttribute("src")).toBe("file:///tmp/shot/contact-sheet.png");
    expect(picture.dataset.url).toBe("file:///tmp/shot/contact-sheet.png");
  });

  it("Test run asks to allow the exact command and folder first (the app page's sheet allows it)", () => {
    const root = panel(spec({ testRun: { status: "approve", command: "swift test --parallel", folder: "/Users/me/ClaudeCodeBot", output: null, error: null, ranAt: null, matches: null } }));
    const ask = root.querySelector(".spec-test .command-approve")!;
    expect(ask.textContent).toContain("/Users/me/ClaudeCodeBot");
    expect(ask.querySelector(".command-full")?.textContent).toBe("swift test --parallel");
    click(ask.querySelector(".command-allow"));
    expect(calls).toEqual([{ method: "testRun", id: "S1", command: "swift test --parallel", folder: "/Users/me/ClaudeCodeBot" }]);
  });

  it("Test run's output is checked against the fields", () => {
    const root = panel(spec({ testRun: { status: "done", command: "swift test", folder: "/p", output: '{"total":3}', error: null, ranAt: "22:14", matches: false } }));
    expect(root.querySelector(".spec-test .spec-check")?.textContent).toContain("does not match");
    calls.length = 0;
    click(root.querySelector(".spec-test-run"));
    expect(calls).toEqual([{ method: "testRun", id: "S1", command: "swift test --parallel", folder: "/Users/me/ClaudeCodeBot" }]);
  });

  it("Build it, Cancel and collapse back to the chip", () => {
    const root = panel(spec());
    expect(root.querySelector(".spec-foot")?.textContent).toContain("Open questions use the suggested answers");
    click(root.querySelector(".spec-build"));
    click(root.querySelector(".spec-cancel"));
    click(root.querySelector("[aria-label='Collapse to the chip']"));
    expect(calls).toEqual([{ method: "build", id: "S1" }, { method: "cancel", id: "S1" }, { method: "close" }]);
  });

  it("building shows its progress, done says where it was added", () => {
    const building = panel(spec({ status: "building", steps: [{ label: "Sent to Maintainer", state: "done" }, { label: "Built into the library", state: "doing" }, { label: "Add to ClaudeCodeBot", state: "todo" }] }));
    expect([...building.querySelectorAll(".spec-step")].map((s) => s.className)).toEqual(["spec-step done", "spec-step doing", "spec-step todo"]);
    expect(building.querySelector(".spec-build")).toBeNull();
    const done = panel(spec({ status: "done", preview: "test-summary", bots: [{ name: "ClaudeCodeBot", on: true }, { name: "Arbor", on: true }] }));
    expect(done.querySelector(".spec-title")?.textContent).toContain("test-summary");
    expect(done.querySelector(".spec-added")?.textContent).toContain("Added to ClaudeCodeBot, Arbor");
  });

  it("Edit spec on a built one: its fields can be changed and Rebuild makes a new version", () => {
    const root = panel(spec({ status: "done", preview: "test-summary", questions: [] }));
    expect(root.querySelector("input[data-key='command']")).not.toBeNull();
    expect(root.querySelector(".spec-cancel")).toBeNull();
    const build = root.querySelector<HTMLButtonElement>(".spec-build")!;
    expect(build.textContent).toBe("Rebuild");
    click(build);
    expect(calls).toEqual([{ method: "build", id: "S1" }]);
  });

  it("an existing component only asks which bots", () => {
    const root = panel(spec({ existing: "git-log", name: "git-log", preview: null }));
    expect(root.querySelector(".spec-field [data-key='command']")).toBeNull();
    expect(root.querySelector(".spec-bots")).not.toBeNull();
    expect(root.querySelector(".spec-build")?.textContent).toBe("Add to bots");
  });

  it("keeps what you are typing across a redraw", () => {
    document.body.innerHTML = `<div id="panel-root"></div>`;
    const root = document.getElementById("panel-root")!;
    const view = new SpecPanel(root, io);
    view.update(spec());
    const box = root.querySelector<HTMLTextAreaElement>(".spec-say textarea")!;
    box.value = "half typed";
    box.focus();
    view.update(spec({ draft: 3 }));
    const again = root.querySelector<HTMLTextAreaElement>(".spec-say textarea")!;
    expect(again.value).toBe("half typed");
    expect(document.activeElement).toBe(again);
  });
});

// In Traditional Chinese, the words this panel was first written with.
describe("changing a built component from its panel", () => {
  beforeEach(() => { document.documentElement.lang = "zh-Hant"; });
  afterEach(() => { document.documentElement.lang = "en"; });
  function panel(state: SpecState): HTMLElement {
    document.body.innerHTML = `<div id="panel-root"></div>`;
    const root = document.getElementById("panel-root")!;
    new SpecPanel(root, io).update(state);
    return root;
  }

  const built = (overrides: Partial<SpecState> = {}) => spec({ status: "done", preview: "test-summary", questions: [], version: 2, ...overrides });

  it("Ask for changes sends the change at once; no Build press needed", () => {
    const root = panel(built());
    const box = root.querySelector<HTMLTextAreaElement>(".spec-say textarea")!;
    expect(box.placeholder).toBe("想怎麼改…");
    expect(root.querySelector(".spec-say-hint")?.textContent).toContain("v3");
    // Rebuild stays only as a secondary action.
    const rebuild = root.querySelector<HTMLButtonElement>(".spec-build")!;
    expect(rebuild.textContent).toBe("重新建置");
    expect(rebuild.classList.contains("primary")).toBe(false);
    box.value = "失敗的要列名字";
    click(root.querySelector(".spec-say button"));
    expect(calls).toEqual([{ method: "say", id: "S1", text: "失敗的要列名字", request: expect.any(String) }]);
    // Right away the panel says Maintainer is on it, before Swift sends the spec back,
    // and nothing can be built again meanwhile.
    expect(root.querySelector(".spec-status")?.textContent).toContain("Maintainer 正在改…（v3）");
    expect(root.querySelector(".spec-build")).toBeNull();
  });

  it("mid-change: status line with version and elapsed time, steps, and no build button", () => {
    const root = panel(built({
      status: "building",
      change: { state: "working", version: 3, startedAt: Date.now() - 65_000, endedAt: null, error: null },
      steps: [{ label: "Sent to Maintainer", state: "done" }, { label: "Maintainer makes v3", state: "doing" }, { label: "v3 in the library", state: "todo" }],
    }));
    const status = root.querySelector(".spec-status")!;
    expect(status.classList.contains("working")).toBe(true);
    expect(status.querySelector(".spinner")).not.toBeNull();
    expect(status.textContent).toContain("Maintainer 正在改…（v3）");
    expect(status.querySelector(".spec-elapsed")?.textContent).toBe("1:05");
    expect([...root.querySelectorAll(".spec-step")].map((s) => s.className)).toEqual(["spec-step done", "spec-step doing", "spec-step todo"]);
    expect(root.querySelector(".spec-build")).toBeNull();
    expect(root.querySelector<HTMLTextAreaElement>(".spec-say textarea")!.placeholder).toContain("排入下一次修改");
  });

  it("what was typed during a change is shown as queued for the next one", () => {
    const root = panel(built({
      status: "building",
      change: { state: "working", version: 3, startedAt: Date.now(), endedAt: null, error: null },
      queued: ["加上耗時", "標題改成中文"],
    }));
    const queued = root.querySelector(".spec-queued")!;
    expect(queued.textContent).toContain("v3 完成後一起送出");
    expect([...queued.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["加上耗時", "標題改成中文"]);
  });

  it("after the new version lands: 已更新成 v3", () => {
    const root = panel(built({
      version: 3,
      change: { state: "updated", version: 3, startedAt: Date.now() - 90_000, endedAt: Date.now(), error: null },
      steps: [{ label: "Sent to Maintainer", state: "done" }, { label: "Maintainer makes v3", state: "done" }, { label: "v3 in the library", state: "done" }],
    }));
    const status = root.querySelector(".spec-status")!;
    expect(status.classList.contains("updated")).toBe(true);
    expect(status.textContent).toContain("已更新成 v3");
    expect(status.querySelector(".spinner")).toBeNull();
    expect(root.querySelector(".spec-build")?.textContent).toBe("重新建置");
  });

  it("a change that did not land says why", () => {
    const root = panel(built({
      change: { state: "failed", version: 3, startedAt: Date.now() - 5000, endedAt: Date.now(), error: "Maintainer's turn ended without a new version: 我看不到那個資料夾。" },
      steps: [{ label: "Sent to Maintainer", state: "done" }, { label: "Maintainer makes v3", state: "failed" }, { label: "v3 in the library", state: "failed" }],
    }));
    const status = root.querySelector(".spec-status")!;
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.textContent).toContain("v3 沒有做出來");
    expect(status.textContent).toContain("我看不到那個資料夾");
    expect(root.querySelector(".spec-step.failed")).not.toBeNull();
  });

  it("Maintainer's one question shows with options, and says the answer carries on", () => {
    const root = panel(built({
      questions: [{ id: "q1", text: "字變小還是卡片變窄？", options: [{ label: "字變小" }, { label: "卡片變窄" }], suggested: 0 }],
      change: { state: "asking", version: 3, startedAt: Date.now(), endedAt: null, error: null },
    }));
    expect(root.querySelector(".spec-status")?.textContent).toContain("Maintainer 有一個問題");
    const answers = [...root.querySelectorAll(".spec-question button")];
    expect(answers.map((a) => a.textContent)).toEqual(["字變小 · 建議", "卡片變窄"]);
    click(answers[1]);
    expect(calls).toEqual([{ method: "answer", id: "S1", question: "q1", option: 1 }]);
  });

  it("a draft keeps Build it, and says nothing is built until it is pressed", () => {
    const root = panel(spec());
    const build = root.querySelector<HTMLButtonElement>(".spec-build")!;
    expect(build.textContent).toBe("建置");
    expect(build.classList.contains("primary")).toBe(true);
    expect(root.querySelector(".spec-say-hint")?.textContent).toContain("建置");
    expect(root.querySelector(".spec-status")).toBeNull();
  });
});

describe("the spec panel at narrow widths", () => {
  it("stacks the wide panel's Preview and progress columns when the panel is narrow", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(__dirname, "../studio.css"), "utf8");
    document.head.append(style);
    try {
      // A half-screen window leaves the wide panel too little room for two columns side by side.
      const narrow = [...style.sheet!.cssRules].filter((rule): rule is CSSMediaRule =>
        "media" in rule && /max-width:\s*(\d+)px/.test((rule as CSSMediaRule).media.mediaText));
      const stacked = narrow.find((rule) => [...rule.cssRules].some((inner) =>
        "selectorText" in inner && (inner as CSSStyleRule).selectorText.includes(".spec-panel.wide .spec-body")
        && (inner as CSSStyleRule).style.display === "flex" && (inner as CSSStyleRule).style.getPropertyValue("flex-direction") === "column"));
      expect(stacked, "a max-width rule that stacks .spec-panel.wide .spec-body").toBeDefined();
      const width = Number(/max-width:\s*(\d+)px/.exec(stacked!.media.mediaText)![1]);
      // Two columns need the preview's 420 px plus a usable progress column.
      expect(width).toBeGreaterThanOrEqual(700);
      // The columns fall back to the narrow panel's single scrolling list, in its order.
      const rules = [...stacked!.cssRules].filter((inner): inner is CSSStyleRule => "selectorText" in inner);
      expect(rules.some((inner) => inner.selectorText.includes(".spec-panel.wide .spec-left") && inner.style.display === "contents")).toBe(true);
      expect(rules.some((inner) => inner.selectorText.includes(".spec-panel.wide .spec-body") && inner.style.getPropertyValue("overflow-y") === "auto")).toBe(true);
    } finally {
      style.remove();
    }
  });
});
