// The generated instructions preserve Swift parity, with explicit approved desktop report additions. prompts-golden.json holds the strings the Swift code itself wrote for a set of inputs
//   (archived 1.x: Tests/ClaudeCodeBotCoreTests/DesktopPromptGoldenExport.swift; re-export after changing
//   Prompts.swift, see desktop/README.md);
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

// Swift still exports the languages 2.1.0 dropped (ja, ko, zh-Hans); the desktop app has only these two.
const keptLanguages = (entries: GoldenPrompt[]) => entries.filter((entry) => ["en", "zh-Hant"].includes(entry.input.language));

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

  for (const entry of keptLanguages(golden.prompts as GoldenPrompt[])) {
    it(`matches ${entry.name}`, () => {
      const ours = promptsFor(entry.input);
      for (const key of ["system", "headsRule", "wake", "tidy", "handoff", "resume"] as const) {
        // Desktop collaboration intentionally replaces the legacy broadcast rule only.
        if (key === "headsRule") continue;
        expect(ours[key].replace(ours.headsRule, ""), `${entry.name}.${key}`).toBe(entry.output[key].replace(entry.output.headsRule, ""));
      }
    });
  }

  for (const entry of keptLanguages(golden.codexPrompts as GoldenPrompt[])) {
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

  it("gives agy both app-managed delegation and, in a multi-engine bot, the peer handoff protocol", () => {
    const profile = { name: "Probe", role: "bot" as const, folder: "/fixture", memoryPath: ".bot/memory.md", job: null };
    const heads = { engines: ["claude", "codex", "agy"] as const, handoffs: true, limits: { discussion: 2, review: 3, handoffs: 7 } };
    const multi = botPrompts({ profile, engine: "agy", heads: { ...heads, engines: [...heads.engines] } });
    expect(multi.system).toContain("app_task_checkpoint");
    expect(multi.system).toContain("coordinator");
    expect(multi.system).toContain("<handoff to=");
    expect(multi.system).toContain("7 hand-offs, 3 of them reviews and 2 discussion rounds");
    expect(multi.system).not.toContain("peer handoff tags are unavailable");
    expect(multi.headsRule).toContain("<handoff to=");
    const single = botPrompts({ profile, engine: "agy" });
    expect(single.system).toContain("app_task_checkpoint");
    expect(single.system).not.toContain("<handoff to=");
    expect(single.headsRule).toBe("");
  });

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

  it("routes an explicit request for a peer engine through the handoff tag, not a subagent or CLI", () => {
    const profile = { name: "Probe", role: "bot" as const, folder: "/fixture", memoryPath: ".bot/memory.md", job: null };
    const heads = { engines: ["claude", "agy"] as ("claude" | "agy")[], handoffs: true, limits: DEFAULT_HEADS.limits };
    const system = botPrompts({ profile, engine: "claude", heads }).system;
    expect(system).toContain('<handoff to="agy" kind="task">');
    expect(system).toContain('When the user asks you to call, use or ask Antigravity, end your reply with <handoff to="agy"');
    expect(system).toContain("never emulate it with a subagent, the Agent tool or a local CLI");
    expect(system).toContain("this overrides the default of using subagents");
    const codex = headsRule({ ...heads, engines: ["claude", "codex", "agy"] }, "claude");
    expect(codex).toContain('<handoff to="codex"');
    expect(codex).toContain('<handoff to="agy"');
    expect(headsRule({ ...heads, handoffs: false }, "claude")).not.toContain("never emulate");
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
