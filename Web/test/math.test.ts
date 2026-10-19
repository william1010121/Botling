import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";
import { closingDollar, renderPlainWithMath } from "../src/math";

const inlineCount = (html: string) => (html.match(/class="math-inline"/g) ?? []).length;
const displayCount = (html: string) => (html.match(/class="math-display"/g) ?? []).length;

describe("LaTeX in bot replies", () => {
  it("typesets inline and display math", () => {
    const html = renderMarkdown("梯度是 $\\frac{\\partial L}{\\partial z_i} = p_i - y_i$，其中\n\n$$\n\\sum_i p_i = 1\n$$");
    expect(inlineCount(html)).toBe(1);
    expect(displayCount(html)).toBe(1);
    expect(html).toContain("katex");
  });

  it("supports \\( \\) and \\[ \\]", () => {
    const html = renderMarkdown("行內 \\(a^2\\) 和 \\[b^2\\]");
    expect(inlineCount(html)).toBe(1);
    expect(displayCount(html)).toBe(1);
  });

  it("leaves prices alone", () => {
    const html = renderMarkdown("票價 $5 到 $10 之間");
    expect(inlineCount(html)).toBe(0);
    expect(html).toContain("$5 到 $10");
  });

  it("treats \\$ as a dollar sign", () => {
    const html = renderMarkdown("花了 \\$3 買 $x$");
    expect(inlineCount(html)).toBe(1);
    expect(html).toContain("$3");
  });

  it("does not touch code", () => {
    const html = renderMarkdown("`$x$` 和\n\n```\necho $HOME$\n```");
    expect(inlineCount(html)).toBe(0);
    expect(html).toContain("$x$");
  });

  it("shows a broken formula without breaking the message", () => {
    const html = renderMarkdown("錯的 $\\frac{1}{$ 後面還有字");
    expect(html).toContain("後面還有字");
  });

  it("keeps tables, lists and links", () => {
    const html = renderMarkdown("| 專案 | 狀態 |\n|---|---|\n| blog | 等你 |\n\n- 一\n- 二\n\n[作品集](file:///tmp/a.html)");
    expect(html).toContain("<table>");
    expect(html).toContain("<li>一</li>");
    expect(html).toContain('class="chip"');
    expect(html).toContain('data-url="file:///tmp/a.html"');
  });

  it("never runs HTML the bot writes", () => {
    const html = renderMarkdown("<script>alert(1)</script><img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });

  it("shows images and plays videos", () => {
    const html = renderMarkdown("![面板](file:///tmp/p.png)\n\n![示範](file:///tmp/d.mp4)");
    expect(html).toContain('<img class="media" src="file:///tmp/p.png"');
    expect(html).toContain('<video class="media" src="file:///tmp/d.mp4"');
  });
});

describe("your own messages", () => {
  it("are plain text with math typeset", () => {
    const html = renderPlainWithMath("**不是粗體** 但 $x^2$ 是公式\n<b>也不是標籤</b>");
    expect(html).toContain("**不是粗體**");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("<br>");
    expect(inlineCount(html)).toBe(1);
  });

  it("leave prices alone too", () => {
    expect(inlineCount(renderPlainWithMath("$5 和 $10"))).toBe(0);
  });
});

describe("closing dollar", () => {
  it("follows Pandoc's rule", () => {
    expect(closingDollar("$x$", 0)).toBe(2);
    expect(closingDollar("$ x$", 0)).toBe(-1);
    expect(closingDollar("$x $", 0)).toBe(-1);
    expect(closingDollar("$x$5", 0)).toBe(-1);
    expect(closingDollar("$$", 0)).toBe(-1);
  });
});
