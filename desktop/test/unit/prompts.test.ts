// The generated instructions preserve Swift parity, with explicit approved desktop report additions. Two checks:
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

// Approved desktop-only report guidance (40418b0). Keep the exported Swift goldens intact:
// compose only these reviewed changes, then compare the entire prompt so unrelated drift fails.
function withDesktopReportGuidance(swift: string, worker: boolean): string {
  const reportHeading = "Local HTML report image rules:\n";
  expect(swift.split(reportHeading)).toHaveLength(2);
  let expected = swift.replace(reportHeading, reportHeading +
    "- Keep preview commands, tool names, and decode checks in the internal evidence handback. In user reports, state any missing content or failed check that affects the conclusion or decision, with its practical effect. Omit routine validation boilerplate; never conceal defects or claim checks you did not run.\n");
  if (worker) {
    const oldLead = "- Final report: state completed or failed,";
    expect(expected.split(oldLead)).toHaveLength(2);
    expected = expected.replace(oldLead,
      "- Final report to the coordinator: keep research-only scope, test commands, and preview-tool details in this internal handback, separate from user report prose. User reports still state material uncertainty and failed checks in plain language. State completed or failed,");
  }
  return expected;
}

describe("prompts: the Swift app's strings", () => {
  it("has golden strings for every configuration", () => {
    expect(golden.prompts.length).toBeGreaterThanOrEqual(13);
  });

  for (const entry of golden.prompts as GoldenPrompt[]) {
    it(`matches ${entry.name}`, () => {
      const ours = promptsFor(entry.input);
      for (const key of ["system", "headsRule", "wake", "tidy", "handoff", "resume"] as const) {
        // Desktop collaboration intentionally replaces the legacy broadcast rule only.
        if (key === "headsRule") continue;
        expect(ours[key].replace(ours.headsRule, ""), `${entry.name}.${key}`).toBe(entry.output[key].replace(entry.output.headsRule, ""));
      }
    });
  }

  for (const entry of golden.codexPrompts as GoldenPrompt[]) {
    it(`matches ${entry.name} (a Codex head)`, () => {
      const ours = promptsFor(entry.input, "codex");
      for (const key of ["system", "headsRule", "wake", "tidy", "handoff", "resume", "codexWorkerSystem"] as const) {
        const expected = key === "system" || key === "codexWorkerSystem"
          ? withDesktopReportGuidance(entry.output[key], key === "codexWorkerSystem")
          : entry.output[key];
        if (key === "headsRule") continue;
        expect(ours[key].replace(ours.headsRule, ""), `${entry.name}.${key}`).toBe(expected.replace(entry.output.headsRule, ""));
      }
    });
  }

  it("tells every engine to respect the primary, peer scope, decisions and handoff budget", () => {
    for (const engine of ["claude", "codex", "agy"] as const) {
      const rule = headsRule({engines:["claude","codex","agy"],handoffs:true,limits:{discussion:1,review:4,handoffs:9}},engine);
      expect(rule).toContain("one primary recipient");
      expect(rule).toContain("authorized phase, exact scope");
      expect(rule).toContain("Never delegate a denied action");
      expect(rule).toContain('decision="QUESTION-MESSAGE-UUID"');
      expect(rule).toContain("9 hand-offs, 4 of them reviews and 1 discussion rounds");
      expect(rule).not.toContain("Each user message reaches both");
      expect(headsRule({handoffs:false,limits:DEFAULT_HEADS.limits},engine)).not.toContain('<handoff to=');
    }
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
        if (dual && name === "headsRule") continue; // Behavior checked above; Swift still broadcasts.
        const legacyRule = (golden.prompts as GoldenPrompt[]).find(entry => entry.input.dual)!.output.headsRule;
        const value = dual ? ours[name as keyof typeof ours].replace(ours.headsRule, legacyRule) : ours[name as keyof typeof ours];
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
