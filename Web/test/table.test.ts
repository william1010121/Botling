/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdown, tableColumnWidths } from "../src/markdown";

// The release-notes table from the "排版怪怪的" feedback: a short version column next to a long one.
const releases = [
  "| 版本 | 主要內容 |",
  "|---|---|",
  "| **v1.6.0** | 組件可以跑指令拿資料（`command=`，第一次會先問你允許）；組件可以把圖片傳回給 bot；新的設定畫面（齒輪快捷面板＋⌘, 完整設定）；每個 bot 可以設 subagent 用的模型和思考強度；@ 選單變短；拿掉每日預算；幾項安全修正 |",
  "| **v1.7.0**（以 v1.7.1 發布） | 加入 Codex：左欄有 Codex bot、右欄有「Review with Codex」報告，subagent 改完會自動送 Codex 審、退回再修；斷網 50 分鐘內回來會接著跑；15 分鐘沒動靜會提醒；用量卡片；插話不會中斷背景 subagent |",
  "| **v1.8.0**（還沒發） | 步驟的 OUT 格直接顯示圖片；Review with Codex 可以選範圍和 spec；開放組件叫 Codex 審（`ccb.reviewWithCodex`） |",
].join("\n");

describe("markdown tables", () => {
  it("give a short column its natural width and the long column the rest", () => {
    const widths = tableColumnWidths([
      ["版本", "主要內容"],
      ["**v1.6.0**", "組件可以跑指令拿資料（`command=`，第一次會先問你允許）；組件可以把圖片傳回給 bot；新的設定畫面"],
      ["**v1.7.0**（以 v1.7.1 發布）", "加入 Codex：左欄有 Codex bot、右欄有「Review with Codex」報告，subagent 改完會自動送 Codex 審"],
    ])!;
    expect(widths).toHaveLength(2);
    // "v1.7.0（以 v1.7.1 發布）" is about a third of a bubble; it gets that, never more than 40%.
    expect(widths[0]).toBeGreaterThanOrEqual(30);
    expect(widths[0]).toBeLessThanOrEqual(40);
    expect(widths[0] + widths[1]).toBeCloseTo(100, 0);
  });

  it("cap a short column at 40% and leave tables that fit alone", () => {
    const wide = tableColumnWidths([["a".repeat(60), "b".repeat(200)]])!;
    expect(wide[0]).toBeLessThanOrEqual(40);
    expect(wide[1]).toBeGreaterThanOrEqual(60);
    expect(tableColumnWidths([["Name", "Size"], ["a.txt", "3 KB"]])).toBeNull();
  });

  it("render the widths as columns of a full-width table", () => {
    const html = renderMarkdown(releases);
    const table = new DOMParser().parseFromString(html, "text/html").querySelector("table")!;
    expect(table.classList.contains("fitted")).toBe(true);
    const cols = [...table.querySelectorAll("colgroup col")].map((col) => parseFloat((col as HTMLElement).style.width));
    expect(cols).toHaveLength(2);
    expect(cols[0]).toBeGreaterThanOrEqual(30);
    expect(cols[0]).toBeLessThanOrEqual(40);
    // A small table keeps its natural size.
    expect(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).not.toContain("colgroup");
  });

  it("wrap cells between words, not inside tokens, and align them to the top", () => {
    const css = readFileSync(join(__dirname, "../src/chat.css"), "utf8");
    const cells = css.match(/\.markdown th, \.markdown td \{([^}]*)\}/)![1];
    // The bubble's overflow-wrap: anywhere shrinks a column to one letter ("v1. / 6. / 0").
    expect(cells).toContain("overflow-wrap: break-word");
    expect(cells).toContain("vertical-align: top");
    expect(css).toMatch(/\.markdown table\.fitted \{[^}]*width: 100%/);
  });
});
