import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The page readers ClaudeCodeBot runs in a web AI's page (Sources/ClaudeCodeBot/Resources/
// web-extractors, copied into the plugin ccb-web-extractors). Run here the way the app runs
// them: the script's source, then `extract(document)`. The pages are FIXTURES that mimic
// each site's turn structure (Gemini, ChatGPT, Claude), not saved copies of the real sites.
const here = dirname(fileURLToPath(import.meta.url));
const readers = join(here, "../../Sources/ClaudeCodeBot/Resources/web-extractors");

type Reading = { title: string | null; turns: { role: string; text: string }[] } | { error: string };

function read(site: string, fixture: string): Reading {
  return readHTML(site, readFileSync(join(here, "fixtures", fixture), "utf8"));
}

function readHTML(site: string, html: string): Reading {
  const source = readFileSync(join(readers, `${site}.js`), "utf8");
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

// ChatGPT and Claude: the same contract, and an answer read as Markdown (headings, numbered and
// nested lists, code with its language, tables, quotes, links, math as its TeX).
const CODE = "```";

describe("the ChatGPT page reader", () => {
  it("reads each turn as Markdown, in page order, with the open conversation's title", () => {
    expect(read("chatgpt", "chatgpt-conversation.html")).toEqual({
      title: "Load factor and hashing",
      turns: [
        { role: "user", text: "Why is a hash table O(1) on average?\nAnd what is   the load factor?" },
        {
          role: "assistant",
          text: [
            "### Short answer",
            "",
            "Each slot holds about $\\alpha$ keys on average, where",
            "",
            "$$\\alpha = \\frac{n}{m}$$",
            "",
            "Lookups:",
            "",
            "1. **Hash** the key.",
            "2. Probe with `h(k) + i` until a match or an empty slot.",
            "",
            "- Chaining",
            "- Open addressing",
            "  - linear probing",
            "  - *double* hashing",
            "",
            CODE + "python",
            "def slot(k, m):",
            "    return hash(k) % m",
            "",
            'print(slot("a", 8))',
            CODE,
            "",
            "> Average case, not worst case: one bad hash puts every key in one slot.",
            "",
            "| Scheme | Probe $i$ |",
            "| --- | --- |",
            "| Linear | $h(k)+i$ |",
            "| Quadratic | $h(k)+i^2$ |",
            "",
            "See [Hash table](https://en.wikipedia.org/wiki/Hash_table) for more.",
          ].join("\n"),
        },
        { role: "user", text: "Thanks! Any source?" },
        // Two messages in one turn are one answer; "Thought for 4s" is a button, not words.
        { role: "assistant", text: "Knuth's *The Art of Computer Programming*, volume 3.\n\nAlso CLRS, chapter 11." },
      ],
    });
  });

  it("leaves out an answer still being written, so the question still waits", () => {
    expect(read("chatgpt", "chatgpt-streaming.html")).toEqual({
      title: null,
      turns: [
        { role: "user", text: "What is $\\alpha$?" },
        { role: "assistant", text: "The load factor." },
        { role: "user", text: "And its bound?" },
      ],
    });
  });

  it("still reads the turns when only their <article data-turn> wrappers are left", () => {
    expect(read("chatgpt", "chatgpt-fallback.html")).toEqual({
      title: null,
      turns: [
        { role: "user", text: "Name a prime." },
        { role: "assistant", text: "Seven: $7 \\in \\mathbb{P}$." },
      ],
    });
  });

  it("finds nothing on the start page", () => {
    expect(read("chatgpt", "chatgpt-new.html")).toEqual({ title: null, turns: [] });
  });
});

describe("the Claude page reader", () => {
  it("reads each turn as Markdown, without its folded thinking, artifact cards or buttons", () => {
    expect(read("claude", "claude-conversation.html")).toEqual({
      title: "Hashing basics",
      turns: [
        { role: "user", text: "Explain hashing.\nKeep it short.\n\nUse math where it helps." },
        {
          role: "assistant",
          text: [
            "## The idea",
            "",
            "A hash function maps a key to one of $m$ slots, so with $n$ keys the load factor is",
            "",
            "$$\\alpha = \\frac{n}{m}$$",
            "",
            "3. **Hash** the key with `h(k)`.",
            "4. Look in slot $h(k) \\bmod m$:",
            "   - found, or",
            "   - probe the next one.",
            "",
            // The language label before the code is the fence's, not a line of its own.
            CODE + "python",
            "def slot(key, m):",
            "    return hash(key) % m",
            CODE,
            "",
            "| Case | Cost |",
            "| --- | --- |",
            "| average | $O(1 + \\alpha)$ |",
            "| worst \\| all in one | $O(n)$ |",
            "",
            "> Keep $\\alpha \\le 0.75$.",
          ].join("\n"),
        },
        { role: "user", text: "Thanks." },
        { role: "assistant", text: "You're welcome." },
      ],
    });
  });

  it("leaves out an answer still being written, so the question still waits", () => {
    expect(read("claude", "claude-streaming.html")).toEqual({
      title: null,
      turns: [
        { role: "user", text: "What is $\\alpha$?" },
        { role: "assistant", text: "The load factor." },
        { role: "user", text: "And its bound?" },
      ],
    });
  });

  it("still reads the older .font-claude-message markup", () => {
    expect(read("claude", "claude-fallback.html")).toEqual({
      title: null,
      turns: [
        { role: "user", text: "Name a prime." },
        { role: "assistant", text: "Seven: $7 \\in \\mathbb{P}$." },
      ],
    });
  });

  it("finds nothing on the start page", () => {
    expect(read("claude", "claude-new.html")).toEqual({ title: null, turns: [] });
  });
});

describe("every page reader", () => {
  it.each(["gemini", "chatgpt", "claude"])("%s keeps its page-specific selectors at the top", (site) => {
    const source = readFileSync(join(readers, `${site}.js`), "utf8");
    expect(source.indexOf("const SELECTORS")).toBeGreaterThan(-1);
    expect(source.indexOf("const SELECTORS")).toBeLessThan(source.indexOf("function extract"));
  });

  it("ChatGPT's and Claude's differ only in their selectors", () => {
    const body = (site: string) => {
      const source = readFileSync(join(readers, `${site}.js`), "utf8");
      return source.slice(source.indexOf("function extract"));
    };
    expect(body("claude")).toBe(body("chatgpt"));
  });
});


describe("the Grok page reader (synthetic fixtures, authenticated reading untested)", () => {
  it("reads Markdown and pending questions without reasoning, controls or a streaming answer", () => {
    expect(read("grok", "grok-conversation.html")).toEqual({ title: null, turns: [
      { role: "user", text: "Why hash?" },
      { role: "assistant", text: "## Hash tables\n\nAverage **constant** time.\n\n```python\nlookup(key)\n```" },
      { role: "user", text: "And now?" },
    ] });
  });
  it("does not save the last answer while a stop control is visible", () => {
    expect(readHTML("grok", `<div data-testid="user-message"><p>Check</p></div>
      <div class="response-content-markdown"><p>Partial</p></div>
      <button aria-label="Stop generating">Stop</button>`)).toEqual({ title: null, turns: [{ role: "user", text: "Check" }] });
  });
  it("reads a completed answer and keeps code and TeX", () => {
    expect(readHTML("grok", `<div data-testid="user-message"><p>Formula?</p></div>
      <div class="response-content-markdown"><p>Use <code>n</code> and <span class="katex"><annotation encoding="application/x-tex">x^2</annotation><span class="katex-html">drawn</span></span>.</p></div>`)).toEqual({
      title: null, turns: [{ role: "user", text: "Formula?" }, { role: "assistant", text: "Use `n` and $x^2$." }],
    });
  });
  it("finds no conversation on signed-out or unrelated pages", () => {
    expect(readHTML("grok", `<main><h1>Sign in</h1><form>Email</form></main>`)).toEqual({ title: null, turns: [] });
  });
});
