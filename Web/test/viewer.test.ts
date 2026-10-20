import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { renderDocument, showDocument } from "../src/viewer";

const base = "file:///Users/me/notes/01-10-20%20%E9%96%8B%E6%9C%83.md";

function fragment(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

describe("the Markdown file window", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    sent.length = 0;
  });

  it("draws headings, lists, quotes, bold, code and tables", () => {
    const doc = fragment(renderDocument([
      "# 10/20 開會",
      "## 組長進度",
      "- 上台 **demo**",
      "> 來源：錄音",
      "```js\nlet a = 1;\n```",
      "| a | b |\n|---|---|\n| 1 | 2 |",
    ].join("\n\n"), base));
    expect(doc.querySelector("h1")?.textContent).toBe("10/20 開會");
    expect(doc.querySelector("h2")?.textContent).toBe("組長進度");
    expect(doc.querySelector("li strong")?.textContent).toBe("demo");
    expect(doc.querySelector("blockquote")?.textContent).toContain("來源");
    expect(doc.querySelector("pre code")?.textContent).toContain("let a = 1;");
    expect(doc.querySelectorAll("td")).toHaveLength(2);
  });

  it("typesets $…$ inline and $$…$$ on its own line", () => {
    const doc = fragment(renderDocument("Energy $E = mc^2$ here.\n\n$$\\int_0^1 x\\,dx = \\frac{1}{2}$$", base));
    expect(doc.querySelector(".math-inline .katex")).not.toBeNull();
    expect(doc.querySelector(".math-display .katex-display")).not.toBeNull();
    expect(doc.textContent).not.toContain("$$");
  });

  it("never runs scripts from the file", () => {
    const doc = fragment(renderDocument([
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "[bad](javascript:alert(1)) ![x](javascript:alert(2))",
      "$\\href{javascript:alert(3)}{x}$",
    ].join("\n\n"), base));
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("[onerror]")).toBeNull();
    expect(doc.innerHTML).not.toMatch(/(href|src|data-url)="javascript:/i);
    expect(doc.textContent).toContain("<script>alert(1)</script>");
  });

  it("loads pictures and links beside the file", () => {
    const doc = fragment(renderDocument("![圖](pics/a.png)\n\n![web](https://example.com/b.png)\n\n[下一篇](next.md) [site](https://example.com)", base));
    const images = [...doc.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(images).toEqual(["file:///Users/me/notes/pics/a.png", "https://example.com/b.png"]);
    const links = [...doc.querySelectorAll<HTMLElement>("[data-url]")].filter((el) => el.tagName === "A").map((a) => a.dataset.url);
    expect(links).toEqual(["file:///Users/me/notes/next.md", "https://example.com"]);
  });

  it("shows the formatted file, with a Source toggle for the raw text", () => {
    const text = "# 標題\n\n**粗體** $x^2$";
    showDocument({ text, base, name: "a.md" });
    const article = document.querySelector<HTMLElement>("article.markdown")!;
    const source = document.querySelector<HTMLElement>("pre.source")!;
    const toggle = document.querySelector<HTMLButtonElement>("button.source-toggle")!;
    expect(article.querySelector("h1")?.textContent).toBe("標題");
    expect(article.hidden).toBe(false);
    expect(source.hidden).toBe(true);
    expect(toggle.textContent).toBe("Source");

    toggle.click();
    expect(article.hidden).toBe(true);
    expect(source.hidden).toBe(false);
    expect(source.textContent).toBe(text);
    expect(toggle.textContent).toBe("Formatted");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    toggle.click();
    expect(article.hidden).toBe(false);
  });

  it("opens links like the chat does", () => {
    showDocument({ text: "[issue #15](https://github.com/x/y/issues/15)", base, name: "a.md" });
    document.querySelector<HTMLElement>("article a")!.click();
    expect(sent).toEqual([{ type: "openURL", url: "https://github.com/x/y/issues/15", label: "issue #15" }]);
  });
});
