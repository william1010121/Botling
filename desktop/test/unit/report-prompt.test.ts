// The report page rule (2.0 only): every bot, the main bot and Codex workers are told to build
// report pages as ReportSpec v2 with the app's report command, right after the results rule,
// which stays exactly as it was. Without the command (headless tests) nothing is added.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { promptDoc } from "../../reports/v2/promptdoc";
import { AGY_DELEGATION_POLICY } from "../../src/core/prompts-agy";
import { botPrompts, desktopPrompts, codexLocalReportRule, codexWorkerInstructions, reportPageLine, type ReportTool } from "../../src/core/prompts";

const tool: ReportTool = { command: "env -u ELECTRON_RUN_AS_NODE '/Applications/Botling 2.app/Contents/MacOS/Botling 2' --render-report", docs: "/Applications/Botling 2.app/Contents/Resources/report/report-blocks.md" };
const profile = (role: "main" | "manager" | "bot") => ({ name: "P", role, folder: "/tmp/p", memoryPath: role === "main" ? "memory.md" : ".bot/memory.md", job: role === "bot" ? "News" : null });

describe("the report page rule", () => {
  for (const role of ["main", "manager", "bot"] as const) {
    for (const engine of ["claude", "codex"] as const) {
      it(`follows the results rule for a ${role} (${engine}) and keeps the rest unchanged`, () => {
        const plain = botPrompts({ profile: profile(role), engine });
        const ours = desktopPrompts(plain, profile(role), tool);
        const artifacts = role === "main" ? "/tmp/p/artifacts" : "/tmp/p/.bot/artifacts";
        const line = reportPageLine(tool, artifacts);
        const lines = ours.system.split("\n");
        const at = lines.indexOf(line);
        expect(at).toBeGreaterThan(0);
        expect(lines[at - 1]).toContain(role === "main" ? "You are the single point of contact." : "Results meant for the user");
        // Nothing else moves: removing the line gives the prompts without it.
        expect(lines.filter((l) => l !== line).join("\n")).toBe(desktopPrompts(plain, profile(role)).system);
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
        const ours = desktopPrompts(botPrompts({ profile: profile(role), engine }), profile(role), tool);
        const text = ours.system.split("\n").find((l) => l.includes("ReportSpec v2")) ?? "";
        expect(text).toContain("--render-report");
        expect(text).toMatch(/detailed or long report/);
        expect(text).toMatch(/chat reply (carries|has) only a brief conclusion and the link/);
        expect(text).toMatch(/never paste the report body/);
      }
    });
  }

  it("adds nothing when the app has no report command", () => {
    const plain = botPrompts({ profile: profile("bot") });
    expect(desktopPrompts(plain, profile("bot"), null).system).toBe(desktopPrompts(plain, profile("bot")).system);
  });
});

describe("the report page line as a shell command", () => {
  it("keeps a spaced command path and a spaced artifacts path one argument each under zsh", async () => {
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
  it("keeps all report modes and gives direct, consistent wording guidance", () => {
    const line = reportPageLine(tool, "/x/artifacts");
    expect(line).toContain("status, decision, investigation, comparison, plan, results, explainer");
    expect(line).toContain("ASD-STE100-informed plain language: active voice, direct verbs, and consistent terms");
    expect(line).toContain("20 English words or 30 Chinese characters");
    expect(line).toContain("writing guidelines, not renderer checks or formal ASD-STE100 compliance for Chinese");
    expect(line).toContain("Keep useful technical names");
  });

  it("explains uncertainty without inventing confidence or hiding failed checks", () => {
    const line = reportPageLine(tool, "/x/artifacts");
    expect(line).toContain("verified facts and pending inferences with their reasons");
    expect(line).toContain("do not assign mechanical confidence percentages");
    expect(line).toContain("Omit routine defensive boilerplate");
    expect(line).toContain("material uncertainty and failed checks");
    expect(line).toContain("never hide defects or claim unperformed validation");
    expect(line).toContain("flow plus a table of evidence");
    expect(line).toContain("outside the prose");
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
    expect(shipped).toContain("20 English words or 30 Chinese characters");
    expect(shipped).toContain("not renderer checks or formal ASD-STE100 compliance for Chinese");
    expect(shipped).toContain("State material uncertainty and failed checks that affect the decision");
    expect(shipped).toContain("Never conceal defects or claim unperformed validation");
  });
});

describe("the reply length rule reaches every engine", () => {
  for (const engine of ["claude", "codex", "agy"] as const) {
    it(`caps chat replies at 3 sentences and forbids pasting long text (${engine})`, () => {
      for (const role of ["bot", "manager"] as const) {
        const ours = desktopPrompts(botPrompts({ profile: profile(role), engine }), profile(role), tool).system;
        expect(ours).toContain("At most 3 sentences, only the conclusion and the next step");
        expect(ours).toMatch(/never paste long text|Do not paste long text/i);
      }
    });
  }

  it("puts the specific brevity rule near the top of the Antigravity system text, before the delegation policy", () => {
    const system = desktopPrompts(botPrompts({ profile: profile("bot"), engine: "agy" }), profile("bot"), tool).system;
    for (const phrase of ["no praise, greeting or filler opener", "No headings, no bullet lists, no emoji", "how many and what for", "translations and rewrites of a report"]) expect(system).toContain(phrase);
    expect(system.split("\n").findIndex((l) => l.includes("no praise, greeting"))).toBeLessThanOrEqual(2);
    expect(system.indexOf("no praise, greeting")).toBeLessThan(system.indexOf(AGY_DELEGATION_POLICY.slice(0, 60)));
  });
});
