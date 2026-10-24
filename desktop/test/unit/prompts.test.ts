// The generated instructions are the Swift app's, character for character. Two checks:
// - prompts-golden.json holds the strings the Swift code itself wrote for a set of inputs
//   (Tests/ClaudeCodeBotCoreTests/DesktopPromptGoldenExport.swift; re-export after changing
//   Prompts.swift, see desktop/README.md);
// - the SHA-256 digests ClaudePromptCompatibilityTests.swift freezes, read from that file as it is
//   in this checkout, so a change on the Swift side that the port has not followed fails here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { botPrompts, DEFAULT_HEADS, headsRule, isPlainOK, PAUSE_NOTE, RELAY_PREFIX, TIDY_LEAD, WAKE_LEAD, type AppLanguage, type ResultPublishing } from "../../src/core/prompts";
import { archiveEntry, reactionIntro, reactionUpdate, recentChat, reportNote, seenReactions } from "../../src/core/briefing";
import type { ChatRecord } from "../../src/core/store/records";
import { desktop } from "../helpers";

const golden = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "prompts-golden.json"), "utf8"));

interface GoldenPrompt {
  name: string;
  input: { profile: { role: "main" | "manager" | "bot"; name: string; folder: string; instructions?: string; job?: string }; language: AppLanguage; results: ResultPublishing; dual: boolean };
  output: Record<string, string>;
}

function promptsFor(input: GoldenPrompt["input"], engine: "claude" | "codex" = "claude") {
  const { profile } = input;
  return botPrompts({
    profile: {
      name: profile.name, role: profile.role, folder: profile.folder,
      memoryPath: profile.role === "main" ? "memory.md" : ".bot/memory.md",
      job: profile.job ?? null, instructions: profile.instructions ?? null,
    },
    language: input.language,
    results: input.results,
    heads: input.dual ? DEFAULT_HEADS : null,
    engine,
  });
}

describe("prompts: the Swift app's strings", () => {
  it("has golden strings for every configuration", () => {
    expect(golden.prompts.length).toBeGreaterThanOrEqual(13);
  });

  for (const entry of golden.prompts as GoldenPrompt[]) {
    it(`matches ${entry.name}`, () => {
      const ours = promptsFor(entry.input);
      for (const key of ["system", "headsRule", "wake", "tidy", "handoff", "resume"] as const) {
        expect(ours[key], `${entry.name}.${key}`).toBe(entry.output[key]);
      }
    });
  }

  for (const entry of golden.codexPrompts as GoldenPrompt[]) {
    it(`matches ${entry.name} (a Codex head)`, () => {
      const ours = promptsFor(entry.input, "codex");
      for (const key of ["system", "headsRule", "wake", "tidy", "handoff", "resume", "codexWorkerSystem"] as const) {
        expect(ours[key], `${entry.name}.${key}`).toBe(entry.output[key]);
      }
    });
  }

  it("writes each head's rule about the other as Swift does (limits, hand-offs off)", () => {
    const limits = { handoffs: true, limits: { discussion: 1, review: 4, handoffs: 9 } };
    const off = { handoffs: false, limits: DEFAULT_HEADS.limits };
    expect(headsRule(limits, "claude")).toBe(golden.headsRules["claude-limits-1-4-9"]);
    expect(headsRule(limits, "codex")).toBe(golden.headsRules["codex-limits-1-4-9"]);
    expect(headsRule(off, "claude")).toBe(golden.headsRules["claude-off"]);
    expect(headsRule(off, "codex")).toBe(golden.headsRules["codex-off"]);
  });

  it("matches the digests ClaudePromptCompatibilityTests freezes", () => {
    const swift = readFileSync(join(desktop, "..", "Tests", "ClaudeCodeBotCoreTests", "ClaudePromptCompatibilityTests.swift"), "utf8");
    const json = /baseline = #"""\n([\s\S]*?)\n\s*"""#/.exec(swift)?.[1];
    expect(json).toBeTruthy();
    const baseline = JSON.parse(json!) as Record<string, Record<string, string>>;
    expect(Object.keys(baseline)).toHaveLength(8);
    const root = "/tmp/claude-dispatch-compatibility";
    for (const [key, digests] of Object.entries(baseline)) {
      const [index, ...rest] = key.split("-");
      const dual = rest.pop() === "true";
      const language = rest.join("-") as AppLanguage;
      const profile = index === "0"
        ? { role: "main" as const, name: "Main bot", folder: root }
        : { role: "manager" as const, name: "Probe", folder: root, instructions: "Keep the project's billing API stable." };
      const ours = promptsFor({ profile, language, results: "artifactUnlessSensitive", dual });
      for (const [name, digest] of Object.entries(digests)) {
        const value = ours[name as keyof typeof ours];
        expect(createHash("sha256").update(value, "utf8").digest("hex"), `${key}.${name}`).toBe(digest);
      }
    }
  });

  it("keeps the app's leads and notes", () => {
    expect(WAKE_LEAD).toBe(golden.notes.wakeLead);
    expect(TIDY_LEAD).toBe(golden.notes.tidyLead);
    expect(RELAY_PREFIX).toBe(golden.notes.relayPrefix);
    expect(PAUSE_NOTE).toBe(golden.notes.pauseNote);
  });

  it("reads a plain OK as Swift does", () => {
    for (const ok of ["OK", " ok. ", "OK!", "", "…"]) expect(isPlainOK(ok), ok).toBe(true);
    for (const no of ["OK, and I also", "Done", "O K"]) expect(isPlainOK(no), no).toBe(false);
  });
});

describe("briefing: the wake-up's recent lines, the archive, reactions", () => {
  const briefing = golden.briefing;
  const records: ChatRecord[] = briefing.messages.map((row: any) => ({ ...row }));
  const archive = join(briefing.home, "archive");
  // Swift ran with TZ=UTC in locale en_GB with region Taiwan (day/month order, a 12-hour clock
  // without am/pm); the stamp follows the locale, so the check names it.
  const clock = { timeZone: golden.timeZone === "GMT" ? "UTC" : golden.timeZone, locale: "en-GB", hour12: true };

  it("lists the last lines as the Swift wake-up does", () => {
    expect(recentChat(records, { archive, leavingOut: records.at(-1)!.id, ...clock })).toBe(briefing.recentLeavingOutLast);
    expect(recentChat(records, { archive, ...clock })).toBe(briefing.recentAll);
    expect(recentChat([], { archive })).toBe("");
  });

  it("writes archive entries as the Swift app does", () => {
    expect(records.map((record) => archiveEntry(record, { timeZone: clock.timeZone }))).toEqual(briefing.archiveEntries);
  });

  it("introduces reactions, then sends only what changed", () => {
    const current = records.at(-1)!.id;
    expect(reactionIntro(records, current)).toBe(briefing.reactionIntro);
    const empty = seenReactions(records);
    for (const key of Object.keys(empty)) empty[key] = [];
    expect(reactionUpdate(records, empty, current)).toBe(briefing.reactionUpdate);
  });

  it("asks once for a finished subagent's report as the Swift app does", () => {
    expect(reportNote([{ description: "Research the API", status: "completed" }, { description: "Check tests", status: "failed" }])).toBe(golden.notes.reportNote);
  });
});
