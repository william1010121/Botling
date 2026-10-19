import { describe, expect, it } from "vitest";
import { createMarkdown } from "../../../src/markdown";
import { closingDollar, mathPlugin, renderPlainWithMath } from "../src/math";
import { formulaAt } from "../src/web";

const md = createMarkdown();
mathPlugin(md);
const renderMarkdown = (text: string) => md.render(text);

const inlineCount = (html: string) => (html.match(/class="math-inline"/g) ?? []).length;
const displayCount = (html: string) => (html.match(/class="math-display"/g) ?? []).length;

describe("LaTeX in bot replies", () => {
  it("typesets inline and display math", () => {
    const html = renderMarkdown("The gradient is $\\frac{\\partial L}{\\partial z_i} = p_i - y_i$, where\n\n$$\n\\sum_i p_i = 1\n$$");
    expect(inlineCount(html)).toBe(1);
    expect(displayCount(html)).toBe(1);
    expect(html).toContain("katex");
  });

  it("supports \\( \\) and \\[ \\]", () => {
    const html = renderMarkdown("inline \\(a^2\\) and \\[b^2\\]");
    expect(inlineCount(html)).toBe(1);
    expect(displayCount(html)).toBe(1);
  });

  it("leaves prices alone", () => {
    const html = renderMarkdown("tickets between $5 and $10");
    expect(inlineCount(html)).toBe(0);
    expect(html).toContain("$5 and $10");
  });

  it("treats \\$ as a dollar sign", () => {
    const html = renderMarkdown("spent \\$3 on $x$");
    expect(inlineCount(html)).toBe(1);
    expect(html).toContain("$3");
  });

  it("does not touch code", () => {
    const html = renderMarkdown("`$x$` and\n\n```\necho $HOME$\n```");
    expect(inlineCount(html)).toBe(0);
    expect(html).toContain("$x$");
  });

  it("shows a broken formula without breaking the message", () => {
    const html = renderMarkdown("broken $\\frac{1}{$ and more text");
    expect(html).toContain("and more text");
  });

  it("keeps tables, lists and links", () => {
    const html = renderMarkdown("| Project | Status |\n|---|---|\n| blog | waiting |\n\n- one\n- two\n\n[Portfolio](file:///tmp/a.html)");
    expect(html).toContain("<table>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain('class="chip"');
    expect(html).toContain('data-url="file:///tmp/a.html"');
  });

  it("never runs HTML the bot writes", () => {
    const html = renderMarkdown("<script>alert(1)</script><img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });

  it("shows images and plays videos", () => {
    const html = renderMarkdown("![panel](file:///tmp/p.png)\n\n![demo](file:///tmp/d.mp4)");
    expect(html).toContain('<img class="media" src="file:///tmp/p.png"');
    expect(html).toContain('<video class="media" src="file:///tmp/d.mp4"');
  });
});

describe("your own messages", () => {
  it("are plain text with math typeset", () => {
    const html = renderPlainWithMath("**not bold** but $x^2$ is math\n<b>not a tag</b>");
    expect(html).toContain("**not bold**");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("<br>");
    expect(inlineCount(html)).toBe(1);
  });

  it("leave prices alone too", () => {
    expect(inlineCount(renderPlainWithMath("$5 and $10"))).toBe(0);
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

describe("the formula preview finds the formula at the caret", () => {
  it("inside $…$", () => {
    const text = "a $a^2+b$ here";
    expect(formulaAt(text, text.indexOf("+"))).toEqual({ tex: "a^2+b", display: false });
    expect(formulaAt(text, 1)).toBeNull();
  });
  it("while a formula is still being typed", () => {
    expect(formulaAt("x $\\frac{1", 11)).toEqual({ tex: "\\frac{1", display: false });
  });
  it("display formulas", () => {
    const text = "$$x_1$$ & \\[y\\]";
    expect(formulaAt(text, 3)).toEqual({ tex: "x_1", display: true });
    expect(formulaAt(text, text.indexOf("y"))).toEqual({ tex: "y", display: true });
  });
  it("not around prices", () => {
    expect(formulaAt("Fa $5 to $10", 5)).toBeNull();
  });
});
