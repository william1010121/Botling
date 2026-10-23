/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";
import { messageElement } from "../src/messages";
import type { MessageView } from "../src/types";

// jsdom has no layout, so these check the rules that keep the chat column from scrolling sideways:
// a long handoff divider ("Claude → Codex: Claude 頭要停了，請你接手…", 1334px on one line) once
// made #scroller 1430px wide in a 760px window, so the whole chat could be swiped (or scrolled)
// left and every bubble, subagent card and preview card was cut off at the left edge.
const css = readFileSync(join(__dirname, "../src/chat.css"), "utf8");
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`))?.[1] ?? "";
};

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

function message(overrides: Partial<MessageView>): MessageView {
  return {
    id: "m1", role: "bot", text: "", stamp: null, avatar: "data:image/png;base64,AA==",
    choices: null, chosen: null, answer: null, open: false, display: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
    ...overrides,
  };
}

describe("the chat column never scrolls sideways", () => {
  it("the message list hides horizontal overflow", () => {
    expect(rule("#scroller")).toMatch(/overflow-x: hidden/);
  });

  it("a long divider label wraps instead of running past the column", () => {
    const label = rule(".row.divider .label");
    expect(label).not.toMatch(/white-space: nowrap/);
    expect(label).toMatch(/min-width: 0/);
    expect(label).toMatch(/overflow-wrap: anywhere/);
    // The lines either side keep a little length, so a wrapped label still reads as a divider.
    expect(rule(".row.divider .line")).toMatch(/min-width: \d+px/);
  });

  it("a wide table scrolls inside its own block", () => {
    for (const source of ["| a | b |\n|---|---|\n| 1 | 2 |", `| a | b |\n|---|---|\n| ${"x".repeat(80)} | ${"y ".repeat(80)} |`]) {
      const html = new DOMParser().parseFromString(renderMarkdown(source), "text/html");
      const table = html.querySelector("table")!;
      expect(table.parentElement?.className).toBe("table-scroll");
      expect(html.querySelectorAll(".table-scroll > table")).toHaveLength(1);
    }
    expect(rule(".markdown .table-scroll")).toMatch(/overflow-x: auto/);
    expect(rule(".markdown .table-scroll")).toMatch(/max-width: 100%/);
  });

  it("draws the divider's text as one label between two lines", () => {
    const row = messageElement(message({ role: "divider", text: "Claude → Codex: " + "很長的交接說明".repeat(40) }), {});
    expect(row.querySelectorAll(".line")).toHaveLength(2);
    expect(row.querySelector(".label")?.textContent).toContain("Claude → Codex");
  });
});

describe("a page preview card's report flag", () => {
  it("sits in the top-left corner, off its 開啟完整頁面 button", () => {
    const preview = { template: "<button>open</button>", version: 0, working: false, updated: false, hasPrevious: false };
    const data = JSON.stringify({ title: "A", url: "file:///p/.bot/artifacts/a.html", src: "ccb-preview://page/p/.bot/artifacts/a.html" });
    const row = messageElement(message({ text: "[A](file:///p/.bot/artifacts/a.html)", previews: [{ name: "網頁預覽卡片", data }] }), { "網頁預覽卡片": preview });
    const card = row.querySelector(".component.page-preview");
    expect(card).not.toBeNull();
    expect(card!.querySelector(".component-side > .flag")).not.toBeNull();
    const side = rule(".wide-part .component.page-preview > .component-side, .wide-part.component.page-preview > .component-side");
    expect(side).toMatch(/top: 4px/);
    expect(side).toMatch(/left: 4px/);
    expect(side).toMatch(/bottom: auto/);
    expect(side).toMatch(/right: auto/);
  });
});
