// A Markdown result in an artifacts folder gets the 「網頁預覽卡片」 card a result page gets (approved 2026-11-04): found
// in a reply's links, titled by its first `# heading`, served from botling-card://preview as a page the chat's markdown
// draws (tables, code, LaTeX, pictures beside it), with no scripts.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cardData, isArtifactMarkdown, isArtifactPage, isArtifactResult, linkedCards, markdownTitle, previewFile, previewURL } from "../../src/core/page-preview";
import { inlineKatexFonts, MARKDOWN_CSP, markdownMediaSource, markdownPage, markdownResponse, renderMarkdownBody } from "../../src/main/markdown-page";
import { reportPreviewURL } from "../../src/main/report-preview";

const dir = mkdtempSync(join(tmpdir(), "md-preview-"));
const artifacts = join(dir, "artifacts");
mkdirSync(artifacts);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("which files get a card", () => {
  it("takes .md files inside an artifacts folder, as it takes .html", () => {
    expect(isArtifactMarkdown("/p/.bot/artifacts/notes.md")).toBe(true);
    expect(isArtifactMarkdown("/p/artifacts/sub/x.markdown")).toBe(true);
    expect(isArtifactMarkdown("/p/docs/notes.md")).toBe(false);
    expect(isArtifactMarkdown("/p/artifacts/x.html")).toBe(false);
    expect(isArtifactPage("/p/artifacts/x.md")).toBe(false);
    expect(isArtifactResult("/p/artifacts/x.md")).toBe(true);
    expect(isArtifactResult("/p/artifacts/x.html")).toBe(true);
    expect(isArtifactResult("/p/artifacts/x.txt")).toBe(false);
  });
});

describe("its title", () => {
  it("is the first # heading, outside code", () => {
    expect(markdownTitle("intro\n\n# How to read **figure 2**\n\n# Later")).toBe("How to read figure 2");
    expect(markdownTitle("```\n# not this\n```\n## sub\n# This one #")).toBe("This one");
    expect(markdownTitle("## only a subheading\ntext")).toBeNull();
  });

  it("names the card, else the file name does", () => {
    const titled = join(artifacts, "why-loss.md");
    writeFileSync(titled, "# Why the loss rises\n\nBecause…");
    const plain = join(artifacts, "draft-notes.md");
    writeFileSync(plain, "no heading here");
    const one = JSON.parse(cardData(JSON.stringify({ path: titled, title: "link label" })));
    expect(one).toMatchObject({ title: "Why the loss rises", name: "why-loss.md", missing: false, url: pathToFileURL(titled).href });
    expect(one.src).toMatch(/^botling-card:\/\/preview\/.*why-loss\.md\?v=\d+$/);
    expect(JSON.parse(cardData(JSON.stringify({ path: plain }))).title).toBe("draft-notes");
  });

  it("comes from a reply's link, within the per-message limit", () => {
    const files = ["a", "b", "c", "d"].map((name) => { const file = join(artifacts, `${name}.md`); writeFileSync(file, `# Note ${name}`); return file; });
    const text = files.map((file, i) => `[n${i}](${pathToFileURL(file).href})`).join(" ");
    const cards = linkedCards(text).map((card) => JSON.parse(card));
    expect(cards.map((card) => card.title)).toEqual(["Note a", "Note b", "Note c"]);
    const outside = join(dir, "outside.md");
    writeFileSync(outside, "# Outside");
    expect(linkedCards(`[x](${pathToFileURL(outside).href})`)).toEqual([]);
  });
});

describe("serving it", () => {
  it("is allowed only inside an artifacts folder, and opens full-size through the same route", () => {
    const file = join(artifacts, "served.md");
    writeFileSync(file, "# Served");
    expect(previewFile(previewURL(file))).toBe(file.replace(/^\/var\//, "/private/var/"));
    expect(reportPreviewURL(pathToFileURL(file).href)).toBe(previewURL(file));
    const outside = join(dir, "private.md");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(artifacts, "escape.md"));
    expect(() => reportPreviewURL(join(artifacts, "escape.md"))).toThrow();
    expect(() => reportPreviewURL(outside)).toThrow();
  });

  it("answers with an HTML page under a policy that runs no script", async () => {
    const file = join(artifacts, "page.md");
    writeFileSync(file, "# Page\n\ntext");
    const response = markdownResponse(file, { chatCSS: ".markdown{color:red}" });
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Security-Policy")).toBe(MARKDOWN_CSP);
    expect(MARKDOWN_CSP).not.toMatch(/script-src/);
    expect(MARKDOWN_CSP).toMatch(/default-src 'none'/);
    expect(MARKDOWN_CSP.split("; ")[0]).toBe("sandbox");
    const html = await response.text();
    expect(html).toContain("<title>Page</title>");
    expect(html).toContain(".markdown{color:red}");
    expect(markdownResponse(file, {}, "HEAD").body).toBeNull();
  });
});

describe("rendering it as the chat does", () => {
  it("draws tables, code and LaTeX", () => {
    const body = renderMarkdownBody("| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\nInline $x^2$ and\n\n$$\\int_0^1 x\\,dx$$\n\nCosts $5 and $6.");
    expect(body).toContain('<div class="table-scroll"><table>');
    expect(body).toContain('<code class="language-ts">const x = 1;');
    expect(body).toContain('<span class="math-inline"><span class="katex">');
    expect(body).toContain('<div class="math-display">');
    expect(body).toContain("Costs $5 and $6.");
  });

  it("shows raw HTML as text and refuses script links", () => {
    const body = renderMarkdownBody('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[go](javascript:alert(1))');
    expect(body).not.toMatch(/<script|<img src=x|href="javascript/i);
    expect(body).toContain("&lt;script&gt;");
  });

  it("loads pictures beside the file, and local absolute ones through the preview origin", () => {
    expect(markdownMediaSource("figs/loss.png")).toBe("figs/loss.png");
    expect(markdownMediaSource("file:///p/artifacts/a b.png")).toBe(previewURL("/p/artifacts/a b.png"));
    expect(markdownMediaSource("/p/artifacts/c.png")).toBe(previewURL("/p/artifacts/c.png"));
    const body = renderMarkdownBody("![Loss curve](figs/loss.png)");
    expect(body).toContain('<img class="media" src="figs/loss.png" alt="Loss curve"');
    expect(body).not.toContain('role="button"');
  });

  it("is a whole page titled by its heading, with KaTeX's styles only when it has math", () => {
    const styles = { chatCSS: "/*chat*/", katexCSS: "/*katex*/" };
    expect(markdownPage("no heading", "/p/artifacts/plain-notes.md", styles)).toContain("<title>plain-notes</title>");
    const plain = markdownPage("# A <b> title\n\nwords", "/p/artifacts/x.md", styles);
    expect(plain).toContain("<title>A &lt;b&gt; title</title>");
    expect(plain).toContain('<main class="markdown">');
    expect(plain).not.toContain("/*katex*/");
    expect(markdownPage("$x$", "/p/artifacts/x.md", styles)).toContain("/*katex*/");
  });

  it("inlines KaTeX's woff2 fonts so the page loads nothing else", () => {
    const fonts = join(dir, "fonts");
    mkdirSync(fonts);
    writeFileSync(join(fonts, "KaTeX_Main-Regular.woff2"), "WOFF");
    const css = '@font-face{font-family:KaTeX_Main;src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2"),url(fonts/KaTeX_Main-Regular.woff) format("woff");font-weight:400}';
    expect(inlineKatexFonts(css, fonts)).toBe(`@font-face{font-family:KaTeX_Main;src:url(data:font/woff2;base64,${Buffer.from("WOFF").toString("base64")}) format("woff2");font-weight:400}`);
  });
});
