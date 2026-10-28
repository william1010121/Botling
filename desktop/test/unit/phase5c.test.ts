// Phase 5c's strings and values checked against the Swift app's own (test/fixtures/phase5c-golden.json, written
// by Tests/ClaudeCodeBotCoreTests/DesktopPhase5cGoldenExport.swift): the component brief (what the fork is
// asked, what is taken from its answer, how it is started), the engine switch's dividers, and the usage page's
// numbers and words (rate limits, tokens, spending).
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { desktop, tempDir } from "../helpers";
import { cardData, linkedCards, previewCards, previewFile, previewURL } from "../../src/core/page-preview";
import { prepareLibrary } from "../../src/core/maintainer";
import { Command } from "../../src/contract";
import { draftSpec, replyPages } from "../../src/core/specs";
import { OLDER_PREVIEW_TEMPLATES, PREVIEW_ABOUT, PREVIEW_TEMPLATE } from "../../src/core/components/builtins";
import { BRIEF_DENIED_TOOLS, BRIEF_LIMIT, BRIEF_TIMEOUT_MS, BRIEF_TOOLS, briefConfig, briefFrom, briefRequest } from "../../src/core/component-brief";
import { headArguments } from "../../src/core/agent/head";
import { parseLine } from "../../src/core/agent/stream";
import { addSpending, claudeRateLimits, codexRateLimits, codexTokens, freshSpending, type RateLimits, type RateLimitWindow } from "../../src/core/usage";
import { asOf, countdown, dollars, percent, resetDay, staleSince, tokenCount, type LimitWindow } from "../../src/renderer/usage-text";

const G = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "phase5c-golden.json"), "utf8"));
const swiftToMs = (swift: number) => (swift + 978_307_200) * 1000;
/** Swift's export writes a window with resetsAt null when it has none. */
const limitsOf = (limits: RateLimits) => {
  const window = (value: RateLimitWindow | undefined) => (value ? { used: value.used, resetsAt: value.resetsAt ?? null, seen: value.seen } : null);
  return { fiveHour: window(limits.fiveHour), week: window(limits.week) };
};

describe("the component brief (ComponentBrief.swift)", () => {
  it("asks the fork 1.x's words, with the user's message (clipped at 4,000 characters) when there is one", () => {
    for (const request of G.brief.requests) {
      expect(briefRequest({ when: G.brief.when, preview: G.brief.preview }, request.asked || null, G.brief.folder)).toBe(request.text);
    }
  });

  it("takes what <component-brief> holds (else the whole answer), trimmed, clipped at 8,000; nothing: none", () => {
    for (const { answer, brief } of G.brief.briefs) expect(briefFrom(answer)).toBe(brief);
    expect([BRIEF_TIMEOUT_MS, BRIEF_LIMIT, BRIEF_TOOLS, BRIEF_DENIED_TOOLS]).toEqual([G.brief.timeout * 1000, G.brief.limit, G.brief.tools, G.brief.denied]);
  });

  it("starts the fork as 1.x does: the session resumed as a copy, read-only, nothing kept, asking nothing", () => {
    const args = headArguments(briefConfig({ command: "claude", cwd: G.brief.folder, sessionId: "0b07e11c-0000-4000-8000-0000000000ab", resume: false, model: "sonnet", effort: "high", allowedTools: ["Bash"], systemPrompt: "the bot's own" }));
    // Each flag with its value as Swift gives it (2.0's order differs, and its head also streams partial messages).
    const flags = (list: string[]) => {
      const out: Record<string, string | true> = {};
      for (let i = 0; i < list.length; i++) {
        const flag = list[i]!;
        if (!flag.startsWith("--")) continue;
        const value = list[i + 1];
        if (value !== undefined && !value.startsWith("--")) { out[flag] = value; i++; } else out[flag] = true;
      }
      return out;
    };
    const swift = flags(G.brief.arguments);
    const ours = flags(args);
    delete ours["--include-partial-messages"];
    expect(ours).toEqual(swift);
    expect(args[0]).toBe("-p");
  });
});

describe("switching a head's engine (Bot.switchEngine)", () => {
  it("says 1.x's dividers", () => {
    expect(G.engine).toMatchObject({ handoffCodex: "Handoff → Codex", handoffClaude: "Handoff → Claude", switchedCodex: "Switched to Codex", switchedClaude: "Switched to Claude" });
  });
});

describe("usage (RateLimits.swift, Spending, RateLimitText)", () => {
  it("reads Claude's rate_limit_event lines and result lines as Swift does", () => {
    for (const { line, limits } of G.usage.claudeLimits) {
      const ours = claudeRateLimits(line, G.usage.seen);
      expect(ours ? limitsOf(ours) : null).toEqual(limits);
    }
    for (const { line, usage } of G.usage.claudeUsage) {
      const item = parseLine(line).find((candidate) => candidate.kind === "usage");
      expect(item ? { totalCost: (item as any).totalCost, tokens: (item as any).tokens } : null).toEqual(usage);
    }
  });

  it("reads Codex's limits and token breakdowns as Swift does", () => {
    for (const { snapshot, limits } of G.usage.codexLimits) expect(limitsOf(codexRateLimits(snapshot, G.usage.seen))).toEqual(limits);
    for (const { breakdown, tokens } of G.usage.codexTokens) expect(codexTokens(breakdown)).toEqual(tokens);
  });

  it("adds up spending day by day as Swift's spending.json has it", () => {
    let spending = freshSpending("2026-10-24");
    for (const step of G.usage.spending) {
      spending = addSpending(spending, step.amount, step.tokens, step.bot, new Date(swiftToMs(step.at)));
      expect(spending).toEqual(step.spending);
    }
  });

  it("words the limits as Swift does: percent, countdown, the reset day, as of; and when a reading is stale", () => {
    const now = swiftToMs(G.usage.now);
    const ms = (window: any): LimitWindow => ({ used: window.used, resetsAt: window.resetsAt === null ? null : swiftToMs(window.resetsAt), seen: swiftToMs(window.seen) });
    for (const text of G.usage.texts) {
      const window = ms(text.window);
      expect([text.label, percent(window, now), countdown(window, now), resetDay(window, now, "en-US", "UTC"), asOf(window.seen, now)])
        .toEqual([text.label, text.percent, text.countdown, text.resetDay, text.asOf]);
    }
    for (const { limits, staleSince: since } of G.usage.stale) {
      expect(staleSince({ fiveHour: ms(limits.fiveHour), week: ms(limits.week) }, now)).toBe(since === null ? null : swiftToMs(since));
    }
    for (const { count, text } of G.usage.tokenCount) expect(tokenCount(count)).toBe(text);
    for (const { amount, text } of G.usage.dollars) expect(dollars(amount)).toBe(text);
  });
});

describe("result pages' preview cards (PagePreview.swift, ComponentSpecs.draft(from:page:))", () => {
  const P = G.preview;
  // The same files under a folder of this test's own; Swift's paths, scheme and change dates put in for ours.
  const root = realpathSync(tempDir("5c-preview"));
  for (const [file, text] of [["p/.bot/artifacts/report.html", "<!doctype html><h1>報告</h1><ul><li>One</li><li>Two</li></ul>"], ["p/.bot/artifacts/sub/chart.HTM", "<p>chart</p>"],
    ["p/site/index.html", "<p>site</p>"], ["p/.bot/artifacts/notes.txt", "notes"], ["p/.bot/artifacts/My Report 2.html", "<p>two</p>"]] as const) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  mkdirSync(join(root, "p/.bot/artifacts/folder.html"), { recursive: true });
  const ours = (text: string) => text.replaceAll(P.root, root).replaceAll("ccb-preview://page", "botling-card://preview").replace(/\?v=\d+/g, "");
  const same = (text: string) => text.replace(/\?v=\d+/g, "");

  it("gives the card 1.x's data: path, url, name, title, missing, and where its frame loads the page from", () => {
    for (const { data, card } of P.cards) expect(same(cardData(ours(data)))).toBe(ours(card));
  });

  it("draws a card for each result page a message links to (at most three, each once, not one a card shows already)", () => {
    for (const { text, cards, skipping } of P.linked) {
      expect(linkedCards(ours(text)).map(same)).toEqual(cards.map(ours));
      expect(linkedCards(ours(text), [join(root, "p/.bot/artifacts/report.html")]).map(same)).toEqual(skipping.map(ours));
    }
  });

  it("makes a spec from a preview card as 1.x: named after the page, its sample the card, the page's words for Maintainer", () => {
    const page = join(root, "p/.bot/artifacts/My Report 2.html");
    const record = { id: "00000000-0000-4000-8000-0000000000C1", role: "bot", text: ours("Here: [競品比較](file://" + P.root + "/p/.bot/artifacts/report.html)"), date: 800_000_000 } as never;
    const library = { names: ["網頁預覽卡片"] } as never;
    const spec = draftSpec(record, "Shop", join(root, "p"), library, 0, page);
    expect({ name: spec.name, page: spec.page, shownAs: spec.shownAs ?? null, existing: spec.existing ?? null, command: spec.command ?? null, samples: spec.samples.map((entry) => ({ label: entry.label, data: same(entry.data) })) })
      .toEqual({ ...P.spec, page: ours(P.spec.page), samples: P.spec.samples.map((entry: any) => ({ label: entry.label, data: ours(entry.data) })) });
    expect(replyPages(record, page)).toEqual(P.pages.map((entry: any) => ({ path: ours(entry.path), text: entry.text })));
  });

  it("recognizes exact 1.x shipped copies for migration and retains their data documentation", () => {
    expect(OLDER_PREVIEW_TEMPLATES[0]).toBe(P.template);
    expect(PREVIEW_ABOUT).toBe(P.about);
    expect(OLDER_PREVIEW_TEMPLATES.slice(1)).toEqual(P.olderTemplates);
  });

  it("seeds the shipped preview, upgrades old shipped templates, and preserves hand edits", () => {
    const dir = tempDir("5c-seeding");
    const card = join(dir, "plugins/ccb-components/components/網頁預覽卡片");
    prepareLibrary(dir);
    expect(readFileSync(join(card, "template.html"), "utf8")).toBe(PREVIEW_TEMPLATE);
    for (const old of OLDER_PREVIEW_TEMPLATES) {
      writeFileSync(join(card, "template.html"), old);
      prepareLibrary(dir);
      expect(readFileSync(join(card, "template.html"), "utf8")).toBe(PREVIEW_TEMPLATE);
    }
    // Both edits to an old default and a separately migrated plugin template stay byte-for-byte.
    for (const custom of [OLDER_PREVIEW_TEMPLATES[0] + "<!-- custom -->", PREVIEW_TEMPLATE + "<!-- Maintainer -->"]) {
      writeFileSync(join(card, "template.html"), custom);
      prepareLibrary(dir);
      expect(readFileSync(join(card, "template.html"), "utf8")).toBe(custom);
    }
    writeFileSync(join(card, "template.html"), "<p>My card</p>");
    writeFileSync(join(card, "about.md"), "My own usage");
    prepareLibrary(dir);
    expect(readFileSync(join(card, "template.html"), "utf8")).toBe("<p>My card</p>");
    expect(readFileSync(join(card, "about.md"), "utf8")).toBe("My own usage");
  });

  it("previews only bot/notice links with the library present, omitting a page already explicitly shown", () => {
    const path = join(root, "p/.bot/artifacts/report.html");
    const text = `[Report](file://${path})`;
    for (const role of ["bot", "notice"]) expect(previewCards({ role, text }, true)).toHaveLength(1);
    expect(previewCards({ role: "user", text }, true)).toBeNull();
    expect(previewCards({ role: "bot", text }, false)).toBeNull();
    expect(previewCards({ role: "bot", text, displays: [{ name: "網頁預覽卡片", data: JSON.stringify({ path }) }] }, true)).toBeNull();
    const command = { type: "spec.make", botId: "main", messageId: "reply" };
    for (const preview of [-1, 0.5, 3]) expect(Command.safeParse({ ...command, preview }).success).toBe(false);
    for (const preview of [0, 1, 2]) expect(Command.safeParse({ ...command, preview }).success).toBe(true);
  });

  it("serves only files inside an artifacts folder, through symlinks; a page encoded or climbing out is refused", () => {
    const page = join(root, "p/.bot/artifacts/report.html");
    expect(previewFile(previewURL(page, 5))).toBe(page);
    expect(previewFile(previewURL(join(root, "p/.bot/artifacts/My Report 2.html")))).toBe(join(root, "p/.bot/artifacts/My Report 2.html"));
    expect(previewFile(previewURL(join(root, "p/site/index.html")))).toBeNull();
    symlinkSync(join(root, "p/site/index.html"), join(root, "p/.bot/artifacts/escape.html"));
    expect(previewFile(previewURL(join(root, "p/.bot/artifacts/escape.html")))).toBeNull();
    expect(previewFile(`botling-card://preview${root}/p/.bot/artifacts/../../site/index.html`)).toBeNull();
    expect(previewFile(`botling-card://preview${root}/p/.bot/artifacts/%2E%2E/%2E%2E/site/index.html`)).toBeNull();
    expect(previewFile(`botling-card://other${page}`)).toBeNull();
    expect(previewFile(previewURL(join(root, "p/.bot/artifacts/none.html")))).toBeNull();
    expect(previewFile(previewURL(join(root, "p/.bot/artifacts/folder.html")))).toBeNull();
  });
});
