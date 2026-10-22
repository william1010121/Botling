import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The page readers ClaudeCodeBot runs in a web AI's page (Sources/ClaudeCodeBot/Resources/
// web-extractors, copied into the plugin ccb-web-extractors). Run here the way the app runs
// them: the script's source, then `extract(document)`. The pages are FIXTURES that mimic
// Gemini's turn structure, not saved copies of the real site.
const here = dirname(fileURLToPath(import.meta.url));
const readers = join(here, "../../Sources/ClaudeCodeBot/Resources/web-extractors");

type Reading = { title: string | null; turns: { role: string; text: string }[] } | { error: string };

function read(site: string, fixture: string): Reading {
  const source = readFileSync(join(readers, `${site}.js`), "utf8");
  const html = readFileSync(join(here, "fixtures", fixture), "utf8");
  const page = new DOMParser().parseFromString(html, "text/html");
  const before = page.documentElement.outerHTML;
  const result = new Function("document", `${source}\n;return JSON.parse(JSON.stringify(extract(document)));`)(page);
  // Read only: the page is left exactly as it was.
  expect(page.documentElement.outerHTML).toBe(before);
  return result;
}

describe("the Gemini page reader", () => {
  it("reads each turn as plain text, in page order, with the conversation's title", () => {
    const reading = read("gemini", "gemini-conversation.html");
    expect(reading).toEqual({
      title: "Embedding chat sites",
      turns: [
        { role: "user", text: "Can a Mac app show this site\nin an iframe?" },
        {
          role: "assistant",
          text: "No. The site sends headers that forbid framing.\n\n- Use a native WKWebView.\n- Keep a persistent data store.\n\n```\nlet view = WKWebView()\n    view.load(request)\n```",
        },
        { role: "user", text: "Can the app read the answers?" },
        { role: "assistant", text: "It can read the page's text after each answer." },
      ],
    });
  });

  it("writes math once, as its TeX, and a list item's paragraph on its bullet's line", () => {
    const reading = read("gemini", "gemini-math.html");
    if ("error" in reading) throw new Error(reading.error);
    expect(reading.turns[1]).toEqual({
      role: "assistant",
      text: [
        "1. Why hashing?",
        "",
        "- Comparison sorts need $\\Omega(n \\log n)$ time.",
        "- Linear probing: $h'(k, i) := (h(k) + i) \\bmod m$.",
        "",
        "With a load factor $\\alpha := n/m$ each slot holds about $\\alpha$ keys.",
        "",
        "$$h_{(a,b)}(k) := ((ak + b) \\bmod p) \\bmod m$$",
        "",
        "That family is universal.",
      ].join("\n"),
    });
  });

  it("finds nothing on a page with no conversation, rather than an empty transcript", () => {
    expect(read("gemini", "gemini-signed-out.html")).toEqual({ title: null, turns: [] });
  });

  it("keeps its page-specific selectors in one place at the top", () => {
    const source = readFileSync(join(readers, "gemini.js"), "utf8");
    expect(source.indexOf("const SELECTORS")).toBeLessThan(source.indexOf("function extract"));
    expect(readFileSync(join(readers, "README.md"), "utf8")).toContain("function extract(doc)");
  });
});
