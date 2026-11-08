import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error ESM helper without d.ts
import { loadReports } from "../../../reports/load.mjs";

const base = { version: 2, lang: "zh-Hant", title: "數學測試", asOf: "2026-11-08", tldr: "公式要能在離線的單一 HTML 裡排好。" };

describe("botling.report: LaTeX math", () => {
  let api: any;
  beforeAll(async () => { api = await loadReports(); });

  const page = (sections: any[], extra: Record<string, unknown> = {}) => {
    const result = api.renderV2({ ...base, ...extra, sections });
    expect(result.errors).toEqual([]);
    return result.html as string;
  };
  const prose = (text: string) => page([{ title: "x", blocks: [{ type: "prose", text }] }]);

  it("typesets inline $…$ and \\(…\\) as KaTeX with MathML, in prose", () => {
    const html = prose("能量 $E = mc^2$ 與 \\(a^2+b^2\\) 都要排好。");
    expect((html.match(/class="katex"/g) ?? []).length).toBe(2);
    expect(html).toContain("<math");
    expect(html).toContain("<annotation");
    expect(html).not.toContain("$E = mc^2$");
  });

  it("typesets display $$…$$ and \\[…\\] as display math", () => {
    const html = prose("如下：\n\n$$\\frac{a}{b}$$\n\n再來 \\[x_i\\]。");
    expect((html.match(/class="katex-display"/g) ?? []).length).toBe(2);
  });

  it("keeps markdown from mangling TeX (underscores, stars, backslashes)", () => {
    const html = prose("設 $a_i * b_i * c_i$ 與 $\\{x\\}$，**粗體** 仍有效。");
    expect(html).not.toContain("<em>");
    expect(html).toContain("<strong>粗體</strong>");
    expect((html.match(/class="katex"/g) ?? []).length).toBe(2);
  });

  it("does not turn currency like \"$4 and $20\" into math", () => {
    const html = prose("價格是 $4 and $20，也可能是 $5 to $10。");
    expect(html).not.toContain("katex");
    expect(html).toContain("$4 and $20");
  });

  it("never lets an unclosed dollar reach a formula in a later paragraph", () => {
    const html = prose("價錢 $4 and $20 都是錢。\n\n後面的 $x^2$ 才是公式，$\\frac{a}{$ 壞掉。");
    expect(html).toContain("價錢 $4 and $20 都是錢。");
    expect((html.match(/class="katex"/g) ?? []).length).toBe(1);
    expect((html.match(/class="math-error"/g) ?? []).length).toBe(1);
  });

  it("keeps an escaped \\$ as a literal dollar, in prose and in a table cell", () => {
    const html = page([{ title: "x", blocks: [
      { type: "prose", text: "付 \\$a 再付 b\\$ 就好。" },
      { type: "table", columns: ["項目", "價格"], rows: [["茶", "\\$3 與 \\$4"]] },
    ] }]);
    expect(html).not.toContain("katex");
    expect(html).toContain("付 $a 再付 b$ 就好");
    expect(html).toContain("$3 與 $4");
    expect(html).not.toContain("\\$");
  });

  it("typesets math in table cells, callouts, captions and the verdict card", () => {
    const html = page([{ title: "x", blocks: [
      { type: "table", columns: ["式", "值"], rows: [["$x^2$", "1"]] },
      { type: "callout", tone: "info", text: "注意 $\\alpha$ 的範圍" },
    ] }], { tldr: "結論是 $\\sum_{i=1}^n i$ 成立。" });
    expect((html.match(/class="katex"/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("typesets math on slides", () => {
    const result = api.renderV2({ ...base, sections: [{ title: "x", blocks: [{ type: "prose", text: "長版文字", slide: "斜率 $\\beta_1$ 最重要" }] }] }, { mode: "slide" });
    expect(result.html).toContain('class="katex"');
  });

  it("shows invalid TeX as its source in a muted error style, without breaking the page", () => {
    const html = prose("壞公式 $\\frac{a}{$ 與好公式 $x^2$ 並存。這個 $\\undefinedmacro{x}$ 也壞。");
    expect(html).toContain('class="math-error"');
    expect(html).toContain("\\undefinedmacro{x}");
    expect(html).not.toContain("katex-error");
    expect(html).toContain('class="katex"'); // the good one still renders
  });

  it("escapes HTML inside TeX and never lets it become markup", () => {
    const html = prose("看 $a < b$ 與 $\\text{<img src=x onerror=alert(1)>}$ 。");
    expect(html).not.toContain("<img");
  });

  it("leaves code, SVG and attributes alone", () => {
    const html = prose("程式 `$x$` 與 `\\$` 保持原樣，$y$ 才是數學。");
    expect(html).toContain("<code>$x$</code>");
    expect(html).toContain("<code>\\$</code>");
    expect((html.match(/class="katex"/g) ?? []).length).toBe(1);
  });

  it("adds no KaTeX CSS or fonts to a page without math", () => {
    const html = prose("只有 **文字** 與 $5 的價格。");
    expect(html).not.toContain(".katex");
    expect(html).not.toContain("KaTeX_");
    expect(html).not.toContain("font/woff2");
  });

  it("inlines only the needed KaTeX CSS and fonts when the page has math", () => {
    const plain = prose("純文字");
    const html = prose("$x^2$");
    expect(html).toContain(".katex");
    expect(html).toMatch(/@font-face\{[^}]*KaTeX_Main[^}]*data:font\/woff2;base64,/);
    expect(html).toMatch(/@font-face\{[^}]*KaTeX_Math/);
    expect(html).not.toMatch(/@font-face\{[^}]*KaTeX_(Caligraphic|Fraktur|Script|Typewriter|AMS)/);
    expect((html.match(/@font-face/g) ?? []).length).toBeLessThanOrEqual(4);
    expect(html).not.toMatch(/url\(fonts\//);
    expect(html).not.toMatch(/url\(["']?https?:|(src|href)="https?:/); // offline: no CDN, no remote font
    expect(html.length - plain.length).toBeLessThan(160_000);
  });

  it("renderBlock typesets math too", () => {
    const { html } = api.renderBlock({ type: "prose", text: "$z$" });
    expect(html).toContain('class="katex"');
  });
});
