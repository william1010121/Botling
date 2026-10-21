/// <reference types="node" />
import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { feedback, makeComponents, messageElement } from "../src/messages";
import { SpecPanel } from "../src/spec";
import type { ComponentInfo, MessageView, SpecState } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const components: Record<string, ComponentInfo> = {
  網頁預覽卡片: { template: "<div>page</div>", version: 1, working: false, updated: false, hasPrevious: false },
  "test-summary": { template: "<div>tests</div>", version: 1, working: false, updated: false, hasPrevious: false },
};

function reply(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: "m1", role: "bot", text: "382 passed, 0 failed.", stamp: null, avatar: null,
    choices: null, chosen: null, answer: null, open: false, displays: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false, ...overrides,
  };
}

function spec(overrides: Partial<SpecState> = {}): SpecState {
  return {
    id: "S1", name: "test-summary", about: "Test results", status: "draft", draft: 2,
    chat: "ClaudeCodeBot", from: "from ClaudeCodeBot's reply at 22:14", suggestedBy: null, existing: null,
    fields: [{ name: "total", type: "int", by: "app" }, { name: "failures", type: "[suite, test]", by: "maintainer" }],
    command: "swift test --parallel", folder: "/Users/me/ClaudeCodeBot",
    refresh: "manual", minutes: 15,
    bots: [{ name: "ClaudeCodeBot", on: true }, { name: "Arbor", on: false }],
    similar: "build-status", similarAbout: "Whether the last build passed.", reuse: false,
    samples: [{ label: "This reply", data: '{"total":382}' }, { label: "Failing run", data: '{"total":382,"failed":2}' }],
    questions: [{ id: "q1", text: "How often?", options: [{ label: "Only on ↻" }, { label: "Every show" }], suggested: 0 }],
    conversation: [{ kind: "maintainer", text: "其他欄位我照這則回覆填好了。" }, { kind: "event", text: "You edited Command" }],
    origins: { command: "user", refresh: "maintainer" },
    preview: null, components, testRun: null, steps: null, wide: false,
    ...overrides,
  };
}

const click = (element: Element | null | undefined) => (element as HTMLElement).click();

beforeEach(() => {
  sent.length = 0;
  document.body.innerHTML = "";
  feedback.enabled = false;
  makeComponents.enabled = true;
});

describe("make into component, in the chat", () => {
  it("a bot reply's hover column has Make into component between Reply and Not right", () => {
    feedback.enabled = true;
    const row = messageElement(reply(), components);
    const labels = [...row.querySelectorAll(".message-actions > button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Reply", "Make into component", "Not right: send to the developer project"]);
    click(row.querySelector("[aria-label='Make into component']"));
    expect(sent).toEqual([{ type: "makeComponent", messageID: "m1" }]);
  });

  it("without developer mode it still sits under Reply", () => {
    const row = messageElement(reply(), components);
    const labels = [...row.querySelectorAll(".message-actions > button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Reply", "Make into component"]);
  });

  it("a reply that already is a component offers Add to another bot", () => {
    const row = messageElement(reply({ component: "git-log" }), components);
    const button = row.querySelector<HTMLButtonElement>(".make-component")!;
    expect(button.getAttribute("aria-label")).toBe("Add to another bot…");
  });

  it("not where components can't be made (notices, a subagent)", () => {
    expect(messageElement(reply({ role: "notice" }), components).querySelector(".make-component")).toBeNull();
    makeComponents.enabled = false;
    expect(messageElement(reply(), components).querySelector(".make-component")).toBeNull();
  });

  it("an HTML result card's hover toolbar has Make into component", () => {
    const row = messageElement(reply({ previews: [{ name: "網頁預覽卡片", data: '{"page":"/a.html"}' }] }), components);
    const bar = row.querySelector(".preview-bar")!;
    expect(bar.textContent).toContain("Make into component");
    click(bar.querySelector("button"));
    expect(sent).toEqual([{ type: "makeComponent", messageID: "m1", preview: 0 }]);
  });

  it("a chip being built says Building…; pressing it shows its progress", () => {
    const row = messageElement(reply({ specs: [{ id: "S1", name: "test-summary", status: "building", suggested: false, open: false }] }), components);
    const chip = row.querySelector<HTMLButtonElement>(".spec-chip")!;
    expect(chip.textContent).toContain("Building… · test-summary");
    expect(chip.querySelector(".spinner")).not.toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    click(chip);
    expect(sent).toEqual([{ type: "pressSpec", id: "S1" }]);
  });

  it("a bot's suggestion is only a chip; pressing it starts the build", () => {
    const row = messageElement(reply({ specs: [{ id: "S1", name: "test-summary", status: "draft", suggested: true, open: false }] }), components);
    const chip = row.querySelector<HTMLButtonElement>(".spec-chip")!;
    expect(chip.textContent).toContain("Suggested component · test-summary");
    expect(row.querySelector(".spec-edit")).toBeNull();
    // Nothing runs or is drawn until pressed.
    expect(row.querySelector(".spec-built")).toBeNull();
    expect(sent).toEqual([]);
    click(chip);
    expect(sent).toEqual([{ type: "pressSpec", id: "S1" }]);
  });

  it("once built, the component itself shows under the reply, with Edit spec", () => {
    const row = messageElement(reply({ specs: [{
      id: "S1", name: "test-summary", status: "done", suggested: false, open: false,
      component: "test-summary", display: { name: "test-summary", data: '{"total":382}', at: null },
    }] }), components);
    expect(row.querySelector(".spec-chip")).toBeNull();
    const built = row.querySelector(".spec-built")!;
    expect(built.textContent).toContain("test-summary");
    expect(built.querySelector<HTMLIFrameElement>("iframe")!.srcdoc).toContain("<div>tests</div>");
    click(built.querySelector(".spec-edit"));
    expect(sent).toEqual([{ type: "openSpec", id: "S1" }]);
  });

  it("the component made from a reply spans the column at its widest size, framed as a tile", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(__dirname, "../src/chat.css"), "utf8");
    document.head.append(style);
    try {
      const row = messageElement(reply({ specs: [{
        id: "S1", name: "test-summary", status: "done", suggested: false, open: false,
        component: "test-summary", display: { name: "test-summary", data: '{"total":382}', at: null },
      }] }), { ...components, "test-summary": { ...components["test-summary"], sizes: ["1x1", "2x1", "4x2"] } });
      document.body.append(row);
      const column = row.querySelector<HTMLElement>(".bot-column")!;
      expect(column.classList.contains("wide")).toBe(true);
      expect(getComputedStyle(column).maxWidth).toBe("none");
      const built = row.querySelector<HTMLElement>(".spec-built")!;
      const shown = built.querySelector<HTMLElement>(":scope > .component")!;
      // The tile is the frame (the reply's bubble color, rounded); the component draws none.
      expect(getComputedStyle(shown).borderRadius).toBe("18px");
      // Inset inside its tile as a reply's text is, the same on both sides.
      expect(getComputedStyle(shown).paddingLeft).toBe("16px");
      expect(getComputedStyle(shown).paddingRight).toBe("16px");
      expect(row.classList.contains("wide")).toBe(true);
      expect(shown.querySelector<HTMLIFrameElement>("iframe")!.srcdoc).toContain('<html data-size="4x2" data-surface="chat">');
      // The reply's bubble spans the column too, so it and the tile under it are one width
      // (a short reply's bubble no longer stops short of the tile's right edge).
      const bubble = row.querySelector<HTMLElement>(".bot-bubble")!;
      expect(getComputedStyle(bubble).maxWidth).toBe("none");
      expect(getComputedStyle(bubble).alignSelf).toBe("stretch");
      // The component fills its tile: nothing (the report flag, a spinner) takes a column beside it.
      expect(getComputedStyle(shown.querySelector<HTMLElement>(".component-side")!).position).toBe("absolute");
    } finally {
      style.remove();
    }
  });

  it("a built component whose command isn't allowed asks with the exact command and folder", () => {
    const row = messageElement(reply({ specs: [{
      id: "S1", name: "test-summary", status: "done", suggested: false, open: false, component: "test-summary",
      display: { name: "test-summary", data: "null", at: null, command: "swift test --parallel", folder: "/Users/me/p", status: "approve" },
    }] }), components);
    const ask = row.querySelector(".spec-built .command-approve")!;
    expect(ask.textContent).toContain("/Users/me/p");
    expect(ask.querySelector(".command-full")?.textContent).toBe("swift test --parallel");
    // Nothing runs on its own.
    expect(sent).toEqual([]);
    click(ask.querySelector(".command-allow"));
    expect(sent).toEqual([{ type: "specCommand", id: "S1", command: "swift test --parallel", folder: "/Users/me/p", approve: true }]);
  });

  it("a new version being built keeps the component, saying so", () => {
    const row = messageElement(reply({ specs: [{
      id: "S1", name: "test-summary", status: "building", suggested: false, open: true,
      component: "test-summary", display: { name: "test-summary", data: '{"total":382}', at: null },
    }] }), components);
    const built = row.querySelector(".spec-built")!;
    expect(built.textContent).toContain("Building a new version");
    expect(built.querySelector(".spec-edit")?.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("the spec workspace in the right panel", () => {
  function panel(state: SpecState): HTMLElement {
    document.body.innerHTML = `<div id="spec-root"></div>`;
    const root = document.getElementById("spec-root")!;
    new SpecPanel(root).update(state);
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
    const samples = [
      { label: "Failing run", data: '{"total":382,"failed":2}' },
      { label: "Test run", data: '"# Changelog"' },
      { label: "This reply", data: '{"versions":["1.9.0 看板變成格子"]}' },
    ];
    const root = panel(spec({ status: "done", preview: "test-summary", command: null, samples, questions: [] }));
    expect(root.querySelector(".spec-samples button[aria-pressed='true']")?.textContent).toBe("This reply");
    expect(root.querySelector<HTMLIFrameElement>(".spec-preview iframe")!.srcdoc).toContain("看板變成格子");
    // With a command (live data), the real run comes first.
    const live = panel(spec({ id: "S2", status: "done", preview: "test-summary", samples, questions: [] }));
    expect(live.querySelector(".spec-samples button[aria-pressed='true']")?.textContent).toBe("Test run");
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
    expect(sent).toEqual([{ type: "specEdit", id: "S1", key: "command", value: "swift test --skip-build" }]);
    sent.length = 0;
    click([...root.querySelectorAll(".spec-refresh button")].find((b) => b.textContent === "When shown"));
    expect(sent).toEqual([{ type: "specEdit", id: "S1", key: "refresh", value: "shown" }]);
    sent.length = 0;
    click([...root.querySelectorAll(".spec-bots button")].find((b) => b.textContent?.includes("Arbor")));
    expect(sent).toEqual([{ type: "specEdit", id: "S1", key: "bots", value: "ClaudeCodeBot, Arbor" }]);
    sent.length = 0;
    click(root.querySelector(".spec-similar button.reuse"));
    expect(sent).toEqual([{ type: "specEdit", id: "S1", key: "reuse", value: "true" }]);
  });

  it("Maintainer's questions come with suggested answers", () => {
    const root = panel(spec());
    const answers = [...root.querySelectorAll(".spec-question button")];
    expect(answers.map((a) => a.textContent)).toEqual(["Only on ↻ · suggested", "Every show"]);
    click(answers[1]);
    expect(sent).toEqual([{ type: "specAnswer", id: "S1", question: "q1", option: 1 }]);
  });

  it("the side conversation and Anything to add", () => {
    const root = panel(spec());
    expect(root.querySelector(".spec-line.maintainer")?.textContent).toContain("其他欄位");
    expect(root.querySelector(".spec-line.event")?.textContent).toContain("You edited Command");
    const box = root.querySelector<HTMLTextAreaElement>(".spec-say textarea")!;
    expect(box.placeholder).toContain("Anything to add?");
    box.value = "失敗的要列名字";
    click(root.querySelector(".spec-say button"));
    expect(sent).toEqual([{ type: "specSay", id: "S1", text: "失敗的要列名字" }]);
  });

  it("Test run asks to allow the exact command and folder first", () => {
    const root = panel(spec({ testRun: { status: "approve", command: "swift test --parallel", folder: "/Users/me/ClaudeCodeBot", output: null, error: null, ranAt: null, matches: null } }));
    const ask = root.querySelector(".spec-test .command-approve")!;
    expect(ask.textContent).toContain("/Users/me/ClaudeCodeBot");
    expect(ask.querySelector(".command-full")?.textContent).toBe("swift test --parallel");
    click(ask.querySelector(".command-allow"));
    expect(sent).toEqual([{ type: "specTestRun", id: "S1", command: "swift test --parallel", folder: "/Users/me/ClaudeCodeBot", approve: true }]);
  });

  it("Test run's output is checked against the fields", () => {
    const root = panel(spec({ testRun: { status: "done", command: "swift test", folder: "/p", output: '{"total":3}', error: null, ranAt: "22:14", matches: false } }));
    expect(root.querySelector(".spec-test .spec-check")?.textContent).toContain("does not match");
    sent.length = 0;
    click(root.querySelector(".spec-test-run"));
    expect(sent).toEqual([{ type: "specTestRun", id: "S1", command: "swift test --parallel", folder: "/Users/me/ClaudeCodeBot" }]);
  });

  it("Build it, Cancel and collapse back to the chip", () => {
    const root = panel(spec());
    expect(root.querySelector(".spec-foot")?.textContent).toContain("Open questions use the suggested answers");
    click(root.querySelector(".spec-build"));
    click(root.querySelector(".spec-cancel"));
    click(root.querySelector("[aria-label='Collapse to the chip']"));
    expect(sent).toEqual([{ type: "specBuild", id: "S1" }, { type: "specCancel", id: "S1" }, { type: "specClose" }]);
  });

  it("building shows its progress, done says where it was added", () => {
    const building = panel(spec({ status: "building", steps: [{ label: "Sent to Maintainer", state: "done" }, { label: "Built into the library", state: "doing" }, { label: "Add to ClaudeCodeBot", state: "todo" }] }));
    expect([...building.querySelectorAll(".spec-step")].map((s) => s.className)).toEqual(["spec-step done", "spec-step doing", "spec-step todo"]);
    expect(building.querySelector(".spec-build")).toBeNull();
    const done = panel(spec({ status: "done", preview: "test-summary", bots: [{ name: "ClaudeCodeBot", on: true }, { name: "Arbor", on: true }] }));
    expect(done.querySelector(".spec-title")?.textContent).toContain("test-summary");
    expect(done.querySelector(".spec-added")?.textContent).toContain("Added to ClaudeCodeBot, Arbor");
  });

  it("Edit spec on a built one: its fields can be changed and 重新建置 makes a new version", () => {
    const root = panel(spec({ status: "done", preview: "test-summary", questions: [] }));
    expect(root.querySelector("input[data-key='command']")).not.toBeNull();
    expect(root.querySelector(".spec-cancel")).toBeNull();
    const build = root.querySelector<HTMLButtonElement>(".spec-build")!;
    expect(build.textContent).toBe("重新建置");
    click(build);
    expect(sent).toEqual([{ type: "specBuild", id: "S1" }]);
  });

  it("an existing component only asks which bots", () => {
    const root = panel(spec({ existing: "git-log", name: "git-log", preview: null }));
    expect(root.querySelector(".spec-field [data-key='command']")).toBeNull();
    expect(root.querySelector(".spec-bots")).not.toBeNull();
    expect(root.querySelector(".spec-build")?.textContent).toBe("Add to bots");
  });

  it("keeps what you are typing across a redraw", () => {
    document.body.innerHTML = `<div id="spec-root"></div>`;
    const root = document.getElementById("spec-root")!;
    const view = new SpecPanel(root);
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

describe("changing a built component from its panel", () => {
  function panel(state: SpecState): HTMLElement {
    document.body.innerHTML = `<div id="spec-root"></div>`;
    const root = document.getElementById("spec-root")!;
    new SpecPanel(root).update(state);
    return root;
  }

  const built = (overrides: Partial<SpecState> = {}) => spec({ status: "done", preview: "test-summary", questions: [], version: 2, ...overrides });

  it("Ask for changes sends the change at once; no Build press needed", () => {
    const root = panel(built());
    const box = root.querySelector<HTMLTextAreaElement>(".spec-say textarea")!;
    expect(box.placeholder).toBe("Ask for changes…");
    expect(root.querySelector(".spec-say-hint")?.textContent).toContain("v3");
    // Rebuild stays only as a secondary action.
    const rebuild = root.querySelector<HTMLButtonElement>(".spec-build")!;
    expect(rebuild.textContent).toBe("重新建置");
    expect(rebuild.classList.contains("primary")).toBe(false);
    box.value = "失敗的要列名字";
    click(root.querySelector(".spec-say button"));
    expect(sent).toEqual([{ type: "specSay", id: "S1", text: "失敗的要列名字" }]);
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
    expect(answers.map((a) => a.textContent)).toEqual(["字變小 · suggested", "卡片變窄"]);
    click(answers[1]);
    expect(sent).toEqual([{ type: "specAnswer", id: "S1", question: "q1", option: 1 }]);
  });

  it("a draft keeps Build it, and says nothing is built until it is pressed", () => {
    const root = panel(spec());
    const build = root.querySelector<HTMLButtonElement>(".spec-build")!;
    expect(build.textContent).toBe("Build it");
    expect(build.classList.contains("primary")).toBe(true);
    expect(root.querySelector(".spec-say-hint")?.textContent).toContain("Build it");
    expect(root.querySelector(".spec-status")).toBeNull();
  });
});

describe("the spec panel at narrow widths", () => {
  it("stacks the wide panel's Preview and progress columns when the panel is narrow", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(__dirname, "../src/chat.css"), "utf8");
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
