// The generated instructions preserve Swift parity, with explicit approved desktop report additions. prompts-golden.json holds the strings the Swift code itself wrote for a set of inputs
//   (archived 1.x: Tests/ClaudeCodeBotCoreTests/DesktopPromptGoldenExport.swift; re-export after changing
//   Prompts.swift, see desktop/README.md);
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { botPrompts, noteRule, DEFAULT_HEADS, headsRule, isPlainOK, reportOnlyRule, PAUSE_NOTE, RELAY_PREFIX, RESTATE_RULE, TIDY_LEAD, VERBATIM_HANDOFF_RULE, SITE_TOOLS_RULE, FILE_LINK_RULE, WAKE_LEAD, CHOICES_NOT_MEMORY_RULE, CODEX_MAIN_NO_FILES_LINE, QUESTION_GROUP_RULE, type AppLanguage, type ResultPublishing } from "../../src/core/prompts";
import { FILES_TOUCHED_HANDOFF_RULE, WORKER_LOOKUP_RULE, WORKER_NOTIFY_RULE, WORKER_REPORT_BLOCK_RULE, workerNoteRule } from "../../src/core/prompts/delegation";
import { CARD_TAG_RULE } from "../../src/core/card-rule";
import { CLAUDE_WORKER_POLICY } from "../../src/core/agent/claude-workers";
import { AGY_WORKER_POLICY } from "../../src/core/prompts-agy";
import { codexWorkerInstructions, desktopPrompts } from "../../src/core/prompts";
import { MAINTAINER_EDITOR_NATIVE_TEXT, maintainerInstructions } from "../../src/core/maintainer-text";
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
    // Approved 2026-11-14 (the user): workers hand back full paths, so the bot can link them.
    expected = expected.replace("source locations or artifact paths,", "source locations or artifact paths (files and folders as full absolute paths, so the coordinator can link them),");
    // Approved 2026-11-16 (the user, M7-F03): the report ends with the files touched, why, and where to start reading.
    expected = `${expected}\n- ${WORKER_REPORT_BLOCK_RULE}`;
  }
  return expected;
}

// Approved desktop-only routing rules (2026-11-04): discuss in chat when asked, restate a doubtful question first,
// long text still being discussed stays short in chat (no .md results), and a worker's follow-ups go to that same worker.
const PERMISSION_RETRY_RULE = "When \"(App: The user allowed …\" arrives, it says whose call it was. Your own call: run it again exactly as it was. A worker's or subagent's call: do not run it yourself; tell that worker to run it again, as the message says. If the retry is refused again, or when the user did not allow it, do not try it again: carry on without it, or tell the user in one sentence.";
const MAINTAINER_ROUTE = "application source work must not be redirected to Maintainer as a plugin.";
const OLD_FOLLOW_UP = "Use app_send_message with task_id and message for that follow-up; do not append a separate feature, rename, or policy fix to it merely to reuse context or keep one writer.";
function withApprovedRouting(swift: string): string {
  let expected = swift.replace(/(only the conclusion and the next step)\.\n/, `$1; when the user asks to discuss or think something through together, discuss it in chat.\n${RESTATE_RULE}\n`);
  expected = expected.replace(/saved to ([^\n]+?)\/<english-file-name>\.html([\s\S]*?)Pictures and videos shown inline stay file:\/\/ links\./g,
    (_all, folder: string, between: string) => `saved to ${folder}/<english-file-name>.html${between}Pictures and videos shown inline stay file:// links. ${reportOnlyRule(folder)}`);
  // Approved 2026-11-06 (Math): a verbatim request hands over its source, after the coordinator's Maintainer sentence.
  expected = expected.replace(MAINTAINER_ROUTE, `${MAINTAINER_ROUTE} ${VERBATIM_HANDOFF_RULE}`);
  // Approved 2026-11-14 (the user): a file or folder a reply points to is a file:// link, after the chip line.
  expected = expected.replace(/(the app draws it as a clickable chip\.\n)/, `$1${FILE_LINK_RULE}\n`);
  // Approved 2026-11-10 (the user): browser site tools are Maintainer's; a bot asks with <plugin>, after the plugin-library line.
  expected = expected.replace(/(  Only plugin-library extensions [^\n]*\n)/, (line) => `${line}  ${SITE_TOOLS_RULE}\n`);
  // Approved 2026-11-08 (Note tab): the user's note for the bot, after the archive line.
  expected = expected.replace(/(search it with Grep there; read only the parts you need\. Never edit it\.\n)/, (_all, line: string) => `${line}- ${noteRule(swift.includes("- Your memory lives only in memory.md") ? "note.md" : ".bot/note.md")}\n`);
  // Approved 2026-11-08 (Math): the memory note goes with the choices block, never in its place.
  expected = expected.replace(/(Also write the decision into the "[^"\n]+" section of your memory file\.)/g, `$1 ${CHOICES_NOT_MEMORY_RULE}`);
  // Approved 2026-11-08: several questions in one reply (<choices question="…">, multiple="true"), answered together.
  expected = expected.replace(/(  Once the user picks, you receive the text of the chosen option;[^\n]*\n)/g, (line) => `${line}${QUESTION_GROUP_RULE}\n`);
  // Approved 2026-11-08 (DAFAWU): a worker may notify its owner while it runs (app_notify_owner); the owner acts on the
  // note, answers a question with app_send_message, and never takes it for the final report.
  expected = expected.replace("reply with only <no-reply/> and the app shows nothing. ", `reply with only <no-reply/> and the app shows nothing. A worker's question (<app_worker_note kind="question">) is never only interim: answer it. `);
  expected = expected.replace("To stop one, app_cancel_task. Do it yourself only when it is quicker than explaining it.", `To stop one, app_cancel_task. ${workerNoteRule({ steerWorkerRun: true })} Do it yourself only when it is quicker than explaining it.`);
  expected = expected.replace("\n\nThe app delivers worker execution reports through app_task_result", `\n\n${workerNoteRule({ steerWorkerRun: true })}\n\nThe app delivers worker execution reports through app_task_result`);
  // Approved 2026-11-16 (the user, M7-F02): a worker sends independent lookups together and finds a symbol with where.mjs.
  expected = expected.replace("\n- Complete the task before returning your final report.", `\n- ${WORKER_NOTIFY_RULE}\n- ${WORKER_LOOKUP_RULE}\n- Complete the task before returning your final report.`);
  // Approved 2026-11-18 (the user): a worker card (<card>), told to a Claude bot on its own line before the /design line (a Codex head loses it below).
  expected = expected.replace(/^(- When the user says "\/design" or asks for a design)/m, `${CARD_TAG_RULE}\n$1`);
  // Approved 2026-11-08 (the user): task cards are gone, so no bot is told to write <task …/> lines any more.
  expected = expected.replace(/^- The app keeps a task card for each piece of work[^\n]*\n/m, "");
  // Approved 2026-11-18 (the user, prompt audit #7): an allowed call is re-run by its owner: the head's own call by the head, a worker's or subagent's by that worker; a refusal or a second refusal ends it.
  expected = expected.replace("When \"(App: The user allowed …\" arrives, run it again exactly as it was; when they did not allow it, carry on without it.", PERMISSION_RETRY_RULE);
  // Approved 2026-11-16 (the user, M7-F03): the earlier worker's "Files touched" block goes to the next worker on the same work.
  return expected.replace(OLD_FOLLOW_UP, `${OLD_FOLLOW_UP} A follow-up on a worker's result goes to that same worker, not a new one. Every handoff and follow-up quotes the user's own words of their question. ${FILES_TOUCHED_HANDOFF_RULE}`);
}

// Approved 2026-11-11 (context-waste audit, fix 4): a Codex head is not told Claude-only things: the auto-mode classifier's
// words (its own reviewer refuses instead), the /design steps (its note hands a Design to Claude) and Claude Code's tool names.
function withoutClaudeOnly(swift: string): string {
  return swift
    // Approved 2026-11-18 (the user, prompt audit #4): the Codex main bot has no file tools, so its file steps go through an app_handoff worker.
    .replace(/(- You may read anything that helps you answer or decide where work goes\.[^\n]*)/, (line) => `${line}\n${CODEX_MAIN_NO_FILES_LINE}`)
    // Approved 2026-11-18 (the user, prompt audit #6): a maintenance turn goes receipt, end, report, checkpoint, OK.
    .replaceAll("When app_task_result confirms the update completed, reply only OK.", "When app_task_result arrives, record app_task_checkpoint for its task_id (complete only if the report confirms the update, else blocked), then reply only OK if the memory was saved.")
    .replace("Maintenance reports also require a checkpoint before OK.", "A maintenance (tidy or switch) turn goes: acceptance receipt, end the turn, worker report, checkpoint, then OK.")
    .replace(/- When auto mode blocks a tool call you need \("denied by the Claude Code auto mode classifier"\),/, "- When Codex's reviewer refuses a tool call you need,")
    .replace(/^- When the user says "\/design" or asks for a design[^\n]*\n/m, "")
    .replace(`${CARD_TAG_RULE}\n`, "")
    .replace("The Claude Code tools these instructions name (the Artifact tool, ScheduleWakeup, CronCreate, the Agent tool, Skill) are not yours:", "The Artifact tool, Claude Design and Claude Code's own tools are not yours:");
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
        expect(ours[key].replace(ours.headsRule, ""), `${entry.name}.${key}`).toBe(withApprovedRouting(entry.output[key].replace(entry.output.headsRule, "")));
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
        expect(ours[key].replace(ours.headsRule, ""), `${entry.name}.${key}`).toBe(withoutClaudeOnly(withApprovedRouting(expected.replace(entry.output.headsRule, ""))));
      }
    });
  }

  it("the <card> line is told to a Claude bot with app-managed workers only: not to native Agent subagents, not to Codex or Antigravity", () => {
    const profile = { id: "m", name: "P", role: "manager" as const, folder: "/p/repo", memoryPath: ".bot/memory.md", job: null, instructions: "X" };
    const plain = botPrompts({ profile, engine: "claude", language: "en" });
    expect(desktopPrompts(plain, profile, "claude", true).system).toContain(CARD_TAG_RULE);
    expect(desktopPrompts(plain, profile, "claude", false).system).not.toContain("<card title=");
    expect(botPrompts({ profile, engine: "codex", language: "en" }).system).not.toContain("<card title=");
  });

  it("every engine's worker text carries the lookup rule exactly once (M7-F02)", () => {
    const count = (text: string, part: string) => text.split(part).length - 1;
    const profile = { name: "Probe", role: "bot" as const, folder: "/fixture", memoryPath: ".bot/memory.md", job: null };
    for (const [engine, text] of [["claude", CLAUDE_WORKER_POLICY], ["agy", AGY_WORKER_POLICY], ["codex", codexWorkerInstructions(profile, "en")]] as const) {
      expect(count(text, WORKER_LOOKUP_RULE), engine).toBe(1);
    }
    expect(WORKER_LOOKUP_RULE).toContain("Send independent lookups (searches, file reads, symbol lookups) together in one turn; go one at a time only when a lookup needs the result of the one before.");
    // conditional: other users' project folders have no where.mjs, so a worker there must not run it blind
    expect(WORKER_LOOKUP_RULE).toContain("In a checkout that has `desktop/scripts/where.mjs` (Botling's own source), run `node desktop/scripts/where.mjs <name>` from the checkout root first to find where a symbol is defined or used.");
    // workers only: no coordinator text gets it
    for (const engine of ["claude", "codex", "agy"] as const) {
      const prompts = botPrompts({ profile, engine, heads: null, language: "en" });
      expect(prompts.system, engine).not.toContain(WORKER_LOOKUP_RULE);
    }
  });

  it("every engine's worker text asks for the Files touched block once, and every coordinator passes it on once (M7-F03)", () => {
    const count = (text: string, part: string) => text.split(part).length - 1;
    const profile = { name: "Probe", role: "bot" as const, folder: "/fixture", memoryPath: ".bot/memory.md", job: null };
    for (const [engine, text] of [["claude", CLAUDE_WORKER_POLICY], ["agy", AGY_WORKER_POLICY], ["codex", codexWorkerInstructions(profile, "en")]] as const) {
      expect(count(text, WORKER_REPORT_BLOCK_RULE), engine).toBe(1);
    }
    expect(WORKER_REPORT_BLOCK_RULE).toContain("Files touched (full paths), one line each on why, and where the next reader should start.");
    for (const engine of ["claude", "codex", "agy"] as const) for (const role of ["main", "manager", "bot"] as const) {
      const p = { ...profile, role };
      expect(count(desktopPrompts(botPrompts({ profile: p, engine, heads: null, language: "en" }), p, engine, true).system, FILES_TOUCHED_HANDOFF_RULE), `${engine}/${role}`).toBe(1);
    }
    // the reviewer still reads the diff; the block is passed on unchanged
    expect(FILES_TOUCHED_HANDOFF_RULE).toContain("unchanged");
    expect(FILES_TOUCHED_HANDOFF_RULE).toContain("still reads the diff itself");
    // workers get the block rule, not the coordinator sentence
    for (const text of [CLAUDE_WORKER_POLICY, AGY_WORKER_POLICY, codexWorkerInstructions(profile, "en")]) expect(text).not.toContain(FILES_TOUCHED_HANDOFF_RULE);
  });

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

  it("tells an agy main bot about <new-bot> and <new-project> (the app does them), and no head about tags the app refuses it", () => {
    for (const role of ["main", "manager", "bot"] as const) {
      const { system } = botPrompts({ profile: { name: "Probe", role, folder: "/fixture", memoryPath: ".bot/memory.md", job: role === "bot" ? "Read news" : null }, engine: "agy" });
      expect(system.includes("<new-project folder="), role).toBe(role === "main");
      expect(system.includes("<new-bot name="), role).toBe(role === "main");
      expect(system, role).not.toMatch(/<(component|plugin)[ >]/);
    }
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

// Prompt audit 2026-11-18 (items 3-7, approved by the user): text that promised what the engine cannot do.
describe("prompts say what each engine can really do", () => {
  const base = { memoryPath: ".bot/memory.md", job: null, instructions: null };
  const main = { name: "Main", role: "main" as const, folder: "/m", ...base, memoryPath: "memory.md" };
  const MAINTAINER_ID = "DEC0DE00-0000-4000-8000-00000000DEC0";

  it("#4: only the Codex main bot is told it has no file tools; a worker does its memory reads and inbox lines", () => {
    expect(botPrompts({ profile: main, engine: "codex", language: "en" }).system).toContain(CODEX_MAIN_NO_FILES_LINE);
    expect(botPrompts({ profile: main, engine: "claude", language: "en" }).system).not.toContain(CODEX_MAIN_NO_FILES_LINE);
    expect(botPrompts({ profile: { ...main, role: "manager" }, engine: "codex", language: "en" }).system).not.toContain(CODEX_MAIN_NO_FILES_LINE);
  });

  it("#6: the Codex tidy and switch turns go receipt, end, report, checkpoint, OK", () => {
    const { tidy, handoff } = botPrompts({ profile: { ...main, role: "manager" }, engine: "codex", language: "en" });
    for (const text of [tidy, handoff]) {
      const order = ["acceptance receipt", "END YOUR CURRENT TURN", "app_task_result arrives", "app_task_checkpoint", "reply only OK"].map((part) => text.indexOf(part));
      expect(order.every((at) => at >= 0), text).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(text).not.toContain("confirms the update completed, reply only OK");
    }
  });

  it("#7: an allowed call is re-run by its owner, and a refusal ends it", () => {
    for (const engine of ["claude", "codex"] as const) {
      const system = botPrompts({ profile: { ...main, role: "manager" }, engine, language: "en" }).system;
      expect(system).toContain("it says whose call it was. Your own call: run it again exactly as it was. A worker's or subagent's call: do not run it yourself");
      expect(system).toContain("do not try it again");
      expect(system).not.toContain("arrives, run it again exactly as it was;");
    }
  });

  it("#5: Maintainer's component editor is started and followed up the way its transport does it", () => {
    const profile = { id: MAINTAINER_ID, name: "Maintainer", role: "manager" as const, folder: "/lib", ...base, instructions: maintainerInstructions("/lib", "check", "shot") };
    const system = (engine: "claude" | "codex" | "agy", workers: boolean) => desktopPrompts(botPrompts({ profile, engine, language: "en" }), profile, engine, workers).system;
    for (const text of MAINTAINER_EDITOR_NATIVE_TEXT) expect(profile.instructions).toContain(text);
    const codex = system("codex", true);
    expect(codex).toContain('call app_handoff with role "component-editor"');
    expect(codex).toContain("app_send_message with its task_id");
    const claude = system("claude", true);
    expect(claude).toContain('call app_handoff with subagent_type "ccb-core:component-editor"');
    expect(claude).toContain("app_send_message with its task_id");
    for (const text of [codex, claude]) for (const native of MAINTAINER_EDITOR_NATIVE_TEXT) expect(text).not.toContain(native);
    // Native Claude keeps the Agent tool; another bot's text is never rewritten.
    const native = system("claude", false);
    for (const text of MAINTAINER_EDITOR_NATIVE_TEXT) expect(native).toContain(text);
    const other = { ...profile, id: "other-id" };
    expect(desktopPrompts(botPrompts({ profile: other, engine: "codex", language: "en" }), other, "codex", true).system).not.toContain('role "component-editor"');
  });
});
