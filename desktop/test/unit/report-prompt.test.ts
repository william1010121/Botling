// The report page rule (2.0 only): every bot, the main bot and Codex workers are told to build
// report pages as ReportSpec v2 with the app's report command, right after the results rule, whose hand-written
// page is then for other pages only (reports go the ReportSpec way: Math, 2026-11-06); nothing else changes.
// Without the command (headless tests) nothing is added.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { promptDoc } from "../../reports/v2/promptdoc";
import { AGY_DELEGATION_POLICY } from "../../src/core/prompts-agy";
import { botPrompts, desktopPrompts, HAND_WRITTEN_PAGE, REPORT_FIRST_PAGE, reportOnlyRule, codexLocalReportRule, codexWorkerInstructions, shellQuote, type ReportTool } from "../../src/core/prompts";
import { legacyReportPageLine, REPORT_SECTION, reportPageLine, reportSections } from "../report-section";

const tool: ReportTool = { command: "env -u ELECTRON_RUN_AS_NODE '/Applications/Botling 2.app/Contents/MacOS/Botling 2' --render-report", docs: "/Applications/Botling 2.app/Contents/Resources/report/report-blocks.md" };
/** The prompts without the report rule, their results rule pointing report pages at it and leaving what the page rule says to it (what the rule changes besides its line). */
const reportFirst = (text: string) => text.replaceAll(HAND_WRITTEN_PAGE, REPORT_FIRST_PAGE).replaceAll(` ${reportOnlyRule("")}`, "");
const profile = (role: "main" | "manager" | "bot") => ({ name: "P", role, folder: "/tmp/p", memoryPath: role === "main" ? "memory.md" : ".bot/memory.md", job: role === "bot" ? "News" : null });

describe("the report page rule as botling.report gives it", () => {
  const paths = ["/tmp/p/artifacts", "/tmp/p/.bot/artifacts", "/x/My Project's/.bot/artifacts", "<your artifacts folder>"];
  const tools: ReportTool[] = [tool, { command: "ELECTRON_RUN_AS_NODE=1 '/usr/bin/node' '/a b/report.cjs'", docs: "/a b/it's/report-blocks.md" }];
  it("is the line the core wrote before, byte for byte, for any command, guide and artifacts folder", () => {
    for (const t of tools) for (const artifacts of paths) expect(reportPageLine(t, artifacts)).toBe(legacyReportPageLine(t, artifacts));
  });
  for (const role of ["main", "manager", "bot"] as const) {
    it(`puts the whole prompt where the core did, for a ${role}`, () => {
      const plain = botPrompts({ profile: profile(role), engine: "claude" });
      const artifacts = role === "main" ? "/tmp/p/artifacts" : "/tmp/p/.bot/artifacts";
      const got = desktopPrompts(plain, profile(role), "claude", true, reportSections(tool));
      const bare = desktopPrompts(plain, profile(role));
      const anchor = role === "main" ? "- You are the single point of contact." : "Results meant for the user";
      const insert = (text: string, anchorText: string) => { const lines = text.split("\n"); lines.splice(lines.findIndex((l) => l.includes(anchorText)) + 1, 0, legacyReportPageLine(tool, artifacts)); return lines.join("\n"); };
      expect(got.system).toBe(insert(reportFirst(bare.system), anchor));
      expect(got.codexWorkerSystem).toBe(insert(reportFirst(bare.codexWorkerSystem), "Results meant for the user"));
    });
  }
  it("the manifest's command and the section agree, and shell-quotes the guide as the core did", () => {
    expect(REPORT_SECTION.after).toBe("results");
    expect(reportPageLine(tool, "/x")).toContain(`before you write a spec, read ${shellQuote(tool.docs)}:`);
  });
});

describe("the report page rule", () => {
  for (const role of ["main", "manager", "bot"] as const) {
    for (const engine of ["claude", "codex"] as const) {
      it(`follows the results rule for a ${role} (${engine}) and keeps the rest unchanged`, () => {
        const plain = botPrompts({ profile: profile(role), engine });
        const ours = desktopPrompts(plain, profile(role), "claude", true, reportSections(tool));
        const artifacts = role === "main" ? "/tmp/p/artifacts" : "/tmp/p/.bot/artifacts";
        const line = reportPageLine(tool, artifacts);
        const lines = ours.system.split("\n");
        const at = lines.indexOf(line);
        expect(at).toBeGreaterThan(0);
        expect(lines[at - 1]).toContain(role === "main" ? "You are the single point of contact." : "Results meant for the user");
        // Nothing else moves: removing the line gives the prompts without it.
        expect(lines.filter((l) => l !== line).join("\n")).toBe(reportFirst(desktopPrompts(plain, profile(role)).system));
        expect(ours.codexWorkerSystem.split("\n")).toContain(line);
        expect(line).toContain(`${tool.command} spec.json '${artifacts}/<english-name>.html' exactly as quoted`);
        expect(line).toContain(`read '${tool.docs}'`);
      });
    }
  }

  it("names the result contract and leaves publishing to the results rule", () => {
    const line = reportPageLine(tool, "/x/artifacts");
    expect(line).toContain("{ok, errors, warnings, htmlPath, link}");
    expect(line).toContain("as the results rule says");
    expect(line).not.toMatch(/Artifact tool|claude\.ai/);
  });

  for (const engine of ["claude", "codex", "agy"] as const) {
    it(`sends long reports to a ReportSpec v2 page and keeps chat to a brief conclusion plus link (${engine})`, () => {
      for (const role of ["main", "manager", "bot"] as const) {
        const ours = desktopPrompts(botPrompts({ profile: profile(role), engine }), profile(role), "claude", true, reportSections(tool));
        const text = ours.system.split("\n").find((l) => l.includes("ReportSpec v2 JSON, never hand-written HTML")) ?? "";
        expect(text).toContain("--render-report");
        expect(text).toMatch(/settled result that needs visuals or comparison/);
        expect(text).toContain("still being discussed or explained (explanations, how to read a figure, research reasoning, drafts, translations) stays short in chat");
        expect(text).not.toContain("a .md file");
        expect(text).toContain("opens with one sentence that answers the user's question");
        expect(text).toMatch(/chat reply (carries|has) only a brief conclusion and the link/);
        expect(text).toMatch(/never paste the report body/);
      }
    });
  }

  it("adds nothing when the app has no report command", () => {
    const plain = botPrompts({ profile: profile("bot") });
    expect(desktopPrompts(plain, profile("bot"), "claude", true, reportSections(null)).system).toBe(desktopPrompts(plain, profile("bot")).system);
  });
});

describe("the report page line as a shell command", () => {
  it.skipIf(spawnSync("zsh", ["-f", "-c", "true"]).error !== undefined)("keeps a spaced command path and a spaced artifacts path one argument each under zsh", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const base = realpathSync(mkdtempSync(join(tmpdir(), "report line ")));
    const app = join(base, "Botling 2.app", "Contents", "MacOS");
    mkdirSync(app, { recursive: true });
    const binary = join(app, "Botling 2");
    writeFileSync(binary, `#!/bin/sh\n${process.execPath.replaceAll(" ", "\\ ")} -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"\n`);
    chmodSync(binary, 0o755);
    const quoted = `'${binary.replaceAll("'", "'\\''")}'`;
    const artifacts = join(base, "My Project's", ".bot", "artifacts");
    const line = reportPageLine({ command: `${quoted} --render-report`, docs: join(base, "Botling 2.app", "Contents", "Resources", "report", "report-blocks.md") }, artifacts);
    const command = /; run (.*) exactly as quoted/.exec(line)![1].replace("<english-name>", "a b");
    const argv = JSON.parse(execFileSync("zsh", ["-f", "-c", command], { encoding: "utf8" }));
    expect(argv).toEqual(["--render-report", "spec.json", join(artifacts, "a b.html")]);
    expect(line).toContain(`read '${join(base, "Botling 2.app", "Contents", "Resources", "report", "report-blocks.md")}'`);
  });
});


describe("report writing guidance", () => {
  // The prompt line is the contract only; the writing rules it used to carry live in the guide it says to read before every spec.
  const guide = readFileSync(new URL("../../docs/report-blocks.md", import.meta.url), "utf8");
  it("keeps the prompt line to the contract and sends the bot to the guide for every rule", () => {
    const line = reportPageLine(tool, "/x/artifacts");
    expect(line).toContain("status, decision, investigation, comparison, plan, results, explainer");
    expect(line).toContain(`Each time, before you write a spec, read ${shellQuote(tool.docs)}`);
    expect(line).toContain("all writing and chart rules");
    for (const moved of ["ASD-STE100", "mechanical confidence", "first page carries", "flow plus a table"]) expect(line).not.toContain(moved);
  });

  it("keeps in the guide every writing rule the prompt line used to carry", () => {
    expect(guide).toContain("ASD-STE100-informed plain language");
    expect(guide).toMatch(/Active voice, direct verbs/);
    expect(guide).toContain("consistent terms");
    expect(guide).toContain("keep a cause and its effect in one sentence");
    expect(guide).not.toContain("30 Chinese characters");
    expect(guide).toContain("The first page holds five things");
    expect(guide).toContain("writing guidelines, not renderer checks or formal ASD-STE100 compliance for Chinese");
    expect(guide).toContain("Keep useful technical names");
    expect(guide).toContain("gets one plain sentence or everyday analogy the first time it appears");
    expect(guide).toContain("Every number has a reference point and a meaning");
    for (const kind of ["status", "experiment", "investigation", "explainer"]) expect(guide).toContain(`### ${kind}`);
  });

  it("explains uncertainty without inventing confidence or hiding failed checks", () => {
    expect(guide).toContain("Separate verified facts from pending inferences");
    expect(guide).toContain("Do not assign mechanical confidence percentages");
    expect(guide).toContain("Omit routine defensive boilerplate");
    expect(guide).toContain("material uncertainty and failed checks");
    expect(guide).toContain("Never conceal defects or claim unperformed validation");
    expect(guide).toContain("prefer a flowchart plus a table of evidence");
    expect(guide).toContain("test commands, and preview-tool details in the internal handback");
    expect(guide).toContain("no long paths, hashes or logs in prose");
  });

  it("separates internal evidence from user prose while preserving preview checks and scope", () => {
    const local = codexLocalReportRule("/x/artifacts");
    const worker = codexWorkerInstructions(profile("bot"), "en");
    expect(local).toContain("preview commands, tool names, and decode checks in the internal evidence handback");
    expect(local).toContain("failed check that affects the conclusion or decision, with its practical effect");
    expect(local).toContain("validate the saved report in production PagePreview/WKWebView through ccb-preview:");
    expect(local).toContain("never fabricate replacement images or claim unperformed checks passed");
    expect(worker).toContain("research-only scope, test commands, and preview-tool details in this internal handback");
    expect(worker).toContain("For research/design-only work, deliver findings and stop: do not implement source changes");
    expect(worker).toContain("Require explicit user authorization relayed by the coordinator before implementation");
  });
});


describe("generated report writing guide", () => {
  it("ships reasoned uncertainty and causal explanations without mechanical probability bands", () => {
    const generated = promptDoc();
    const shipped = readFileSync(new URL("../../docs/report-blocks.md", import.meta.url), "utf8");
    expect(shipped).toBe(generated);
    expect(shipped).toContain("Separate verified facts from pending inferences");
    expect(shipped).toContain("Give the reason for each inference and state what remains unchecked");
    expect(shipped).toContain("Do not assign mechanical confidence percentages");
    expect(shipped).not.toMatch(/Uncertainty with words \+ %|likelihood words \+ %|95–99|80–95|55–80|45–55|20–45|5–20/);
    expect(shipped).toContain("prefer a flowchart plus a table of evidence");
    expect(shipped).toContain("Distinguish observed links from pending inferences");
    expect(shipped).toContain("ASD-STE100-informed plain language");
    expect(shipped).toContain("keep a cause and its effect in one sentence");
    expect(shipped).not.toContain("30 Chinese characters");
    expect(shipped).toContain("not renderer checks or formal ASD-STE100 compliance for Chinese");
    expect(shipped).toContain("State material uncertainty and failed checks that affect the decision");
    expect(shipped).toContain("Never conceal defects or claim unperformed validation");
  });
});

describe("the reply length rule reaches every engine", () => {
  for (const engine of ["claude", "codex", "agy"] as const) {
    it(`caps chat replies at 3 sentences and forbids pasting long text (${engine})`, () => {
      for (const role of ["bot", "manager"] as const) {
        const ours = desktopPrompts(botPrompts({ profile: profile(role), engine }), profile(role), "claude", true, reportSections(tool)).system;
        expect(ours).toContain("At most 3 sentences, only the conclusion and the next step");
        expect(ours).toMatch(/never paste long text|Do not paste long text/i);
      }
    });
  }

  it("puts the specific brevity rule near the top of the Antigravity system text, before the delegation policy", () => {
    const system = desktopPrompts(botPrompts({ profile: profile("bot"), engine: "agy" }), profile("bot"), "claude", true, reportSections(tool)).system;
    for (const phrase of ["no praise, greeting or filler opener", "No headings, no bullet lists, no emoji", "how many and what for", "translations and rewrites of a report"]) expect(system).toContain(phrase);
    expect(system.split("\n").findIndex((l) => l.includes("no praise, greeting"))).toBeLessThanOrEqual(2);
    expect(system.indexOf("no praise, greeting")).toBeLessThan(system.indexOf(AGY_DELEGATION_POLICY.slice(0, 60)));
  });
});
