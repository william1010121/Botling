// M7-O02: core's default orchestration rules are one set behind `OrchestrationRules`, and their output is today's, byte for byte.
// test/fixtures/orchestration-default-rules-golden.json was captured on the base commit c1be2d03 (before the card) by calling
// delegationPolicy, codexWorkerInstructions and the exported constants directly. One changed character gives every bot a new
// session: regenerate the fixture only on purpose, and say so in the commit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { botPrompts, CLAUDE_WORKERS_RULE, codexWorkerInstructions, desktopPrompts, ON_REQUEST_WORKERS_RULE } from "../../src/core/prompts";
import { AGY_DELEGATION_POLICY, AGY_WORKER_POLICY } from "../../src/core/prompts-agy";
import { DELEGATION_CAPS, delegationPolicy, FILES_TOUCHED_HANDOFF_RULE, policySectionIds, VERBATIM_HANDOFF_RULE, WORKER_LOOKUP_RULE, WORKER_REPORT_BLOCK_RULE, workerNoteRule, type DelegationCaps } from "../../src/core/prompts/delegation";
import { DEFAULT_ORCHESTRATION_RULES as RULES, renderFragments, SECTION_IDS, type Fragment, type OrchestrationRules } from "../../src/core/orchestration/default-rules";
import { desktop } from "../helpers";

const golden: Record<string, string> = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "orchestration-default-rules-golden.json"), "utf8"));
const TREE = "/w/repo-fix";
const ENGINES = ["claude", "codex", "agy"] as const;
const SYNTHETIC: Record<string, DelegationCaps> = {
  "agy-no-reconcile": { ...DELEGATION_CAPS.agy, appTools: new Set(["app_handoff"]) },
  "message-no-steer": { ...DELEGATION_CAPS.codex, steerWorkerRun: false },
  "steer-no-routines": { ...DELEGATION_CAPS.claude, appTools: new Set(["app_handoff"]), reportVia: "message" },
};
/** The fragments as text, joined here on purpose and not with `renderFragments`. */
const concat = (fragments: readonly Fragment[]) => fragments.map((fragment, at) => (at ? fragment.glue ?? " " : "") + fragment.text).join("");
const sectioned = (rules: OrchestrationRules, caps: DelegationCaps, engine: typeof ENGINES[number], worktree: string | null) =>
  policySectionIds(caps).map((id) => concat(rules.section(id, caps, { engine, worktree }))).join("\n\n");

describe("the default rules give today's text, byte for byte", () => {
  for (const engine of ENGINES) for (const tree of [null, TREE]) {
    const where = tree ? "worktree" : "folder";
    it(`${engine} / ${where}: sectioned form`, () => {
      const expected = golden[`policy/${engine}/${where}/full`];
      expect(delegationPolicy(DELEGATION_CAPS[engine], { engine, worktree: tree, form: "full" })).toBe(expected);
      expect(delegationPolicy(DELEGATION_CAPS[engine], { engine, worktree: tree })).toBe(expected);
      expect(sectioned(RULES, DELEGATION_CAPS[engine], engine, tree)).toBe(expected);
    });
  }
  for (const engine of ENGINES) it(`${engine}: Claude's single line`, () => {
    const expected = golden[`policy/${engine}/folder/line`];
    expect(delegationPolicy(DELEGATION_CAPS[engine], { engine, form: "line" })).toBe(expected);
    expect(concat(RULES.claudeLine(DELEGATION_CAPS[engine]))).toBe(expected);
    expect(renderFragments(RULES.claudeLine(DELEGATION_CAPS[engine]))).toBe(expected);
  });
  for (const [name, caps] of Object.entries(SYNTHETIC)) it(`capabilities ${name} (the branches no engine reaches together)`, () => {
    expect(delegationPolicy(caps, { engine: "codex", worktree: null })).toBe(golden[`policy-synthetic/${name}/full`]);
    expect(sectioned(RULES, caps, "codex", null)).toBe(golden[`policy-synthetic/${name}/full`]);
  });
  it("the Antigravity prompt form keeps its trailing newline, as a contract fragment of its own", () => {
    const fragments = RULES.section("reports", DELEGATION_CAPS.agy, { engine: "agy" });
    expect(fragments.at(-1)).toEqual({ id: "reports.prompt.end", kind: "C", text: "", glue: "\n" });
    expect(concat(fragments).endsWith("\n")).toBe(true);
    expect(golden["policy/agy/folder/full"].endsWith("\n")).toBe(true);
    // Without app_reconcile_report the newline still follows the last sentence.
    const plain = RULES.section("reports", SYNTHETIC["agy-no-reconcile"], { engine: "agy" });
    expect(concat(plain).endsWith("not independent app verification.\n")).toBe(true);
  });
  it("the exported constants and the other lines", () => {
    expect(CLAUDE_WORKERS_RULE).toBe(golden["const/CLAUDE_WORKERS_RULE"]);
    expect(ON_REQUEST_WORKERS_RULE).toBe(golden["const/ON_REQUEST_WORKERS_RULE"]);
    expect(concat(RULES.onRequestLine(DELEGATION_CAPS.claude))).toBe(golden["const/ON_REQUEST_WORKERS_RULE"]);
    expect(concat(RULES.claudeMainLine())).toBe(golden["const/CLAUDE_MAIN_WORKERS_LINE"]);
    expect(AGY_DELEGATION_POLICY).toBe(golden["const/AGY_DELEGATION_POLICY"]);
    expect(AGY_WORKER_POLICY).toBe(golden["const/AGY_WORKER_POLICY"]);
    expect(WORKER_LOOKUP_RULE).toBe(golden["const/WORKER_LOOKUP_RULE"]);
    expect(WORKER_REPORT_BLOCK_RULE).toBe(golden["const/WORKER_REPORT_BLOCK_RULE"]);
    expect(FILES_TOUCHED_HANDOFF_RULE).toBe(golden["const/FILES_TOUCHED_HANDOFF_RULE"]);
    expect(VERBATIM_HANDOFF_RULE).toBe(golden["const/VERBATIM_HANDOFF_RULE"]);
    expect(RULES.workerRules().lookup.text).toBe(golden["const/WORKER_LOOKUP_RULE"]);
    expect(RULES.workerRules().reportBlock.text).toBe(golden["const/WORKER_REPORT_BLOCK_RULE"]);
    expect(workerNoteRule({ steerWorkerRun: true })).toBe(golden["note/steer"]);
    expect(workerNoteRule({ steerWorkerRun: false })).toBe(golden["note/nosteer"]);
    expect(concat(RULES.workerNote({ steerWorkerRun: false }))).toBe(golden["note/nosteer"]);
  });
  it("the Codex worker instructions, with and without a worktree", () => {
    const profile = { id: "main-id", name: "P", role: "main" as const, folder: "/p/repo", memoryPath: ".bot/memory.md", job: null, instructions: "X" };
    expect(codexWorkerInstructions(profile, "en", null)).toBe(golden["codexWorker/folder"]);
    expect(codexWorkerInstructions(profile, "en", TREE)).toBe(golden["codexWorker/worktree"]);
    expect(codexWorkerInstructions(profile, "en", TREE, RULES)).toBe(golden["codexWorker/worktree"]);
  });
  it("botPrompts and desktopPrompts take the same set as their default", () => {
    const profile = { id: "p", name: "P", role: "manager" as const, folder: "/p/repo", memoryPath: ".bot/memory.md", job: null, instructions: "X" };
    for (const engine of ["claude", "codex"] as const) {
      const implicit = desktopPrompts(botPrompts({ profile, engine, language: "en" }), profile, engine, true);
      const explicit = desktopPrompts(botPrompts({ profile, engine, language: "en", rules: RULES }), profile, engine, true, undefined, RULES);
      expect(explicit).toEqual(implicit);
    }
  });
  it("a set that gives other text is the one the prompts use (core calls only the interface)", () => {
    const profile = { id: "p", name: "P", role: "manager" as const, folder: "/p/repo", memoryPath: ".bot/memory.md", job: null, instructions: "X" };
    const other: OrchestrationRules = { ...RULES, claudeLine: () => [{ id: "x", kind: "P", text: "- OTHER $& LINE" }], workerRules: () => ({ lookup: { id: "l", kind: "P", text: "LOOKUP?" }, reportBlock: { id: "r", kind: "P", text: "BLOCK?" } }) };
    const system = desktopPrompts(botPrompts({ profile, engine: "claude", language: "en", rules: other }), profile, "claude", true, undefined, other).system;
    expect(system).toContain("- OTHER $& LINE");
    expect(system).not.toContain(CLAUDE_WORKERS_RULE);
    expect(codexWorkerInstructions(profile, "en", null, other)).toContain("- LOOKUP?\n");
  });
});

// The contract fragments of the plan (M7-O01 §2.2 with the review's F1 corrections). A fragment moves from C to P only on
// purpose: edit this list in the same change, and have the change reviewed as a change of what a plugin may replace.
const CONTRACT_IDS = [
  "header", "monitors", "coordinator", "authorization", "scope", "worktree.own", "worktree.attached", "validation",
  "dispatch.1", "dispatch.2", "dispatch.3", "dispatch.4", "dispatch.5a", "dispatch.6", "dispatch.7", "dispatch.8a", "dispatch.8b", "dispatch.9", "dispatch.10", "dispatch.11", "dispatch.12a", "dispatch.12b",
  "ownership.1", "ownership.2", "ownership.3", "ownership.nosteer",
  "followUp.2a", "followUp.8", "followUp.9", "followUp.10",
  "runDispatch.1", "runDispatch.2b", "runDispatch.3", "runDispatch.4a", "runDispatch.6", "runDispatch.7",
  "note.1", "note.2b",
  "reports.1", "reports.2", "reports.4", "reports.5", "reports.6a", "reports.6b", "reports.7", "reports.9", "reports.10", "reports.11", "reports.12", "reports.15",
  "reports.prompt.1", "reports.prompt.2", "reports.prompt.3", "reports.prompt.4", "reports.prompt.5", "reports.prompt.6", "reports.prompt.7", "reports.prompt.8", "reports.prompt.9", "reports.prompt.10", "reports.prompt.end",
  "line.0", "line.1b", "line.2", "line.3b", "line.3d", "line.4", "line.6", "line.9",
  "onRequest.0", "onRequest.1", "onRequest.2", "onRequest.3b", "onRequest.4", "onRequest.6a", "onRequest.8",
  "main.0", "main.1",
];
const POLICY_IDS = [
  "dispatch.5b", "followUp.1", "followUp.2b", "followUp.3", "followUp.4", "followUp.5", "followUp.6", "followUp.7",
  "runDispatch.2a", "runDispatch.4b", "runDispatch.5", "note.2a", "note.3", "reports.3", "reports.8", "reports.13", "reports.14",
  "line.1a", "line.1c", "line.3a", "line.3c", "line.5", "line.7", "line.8", "line.verbatim",
  "onRequest.3a", "onRequest.5", "onRequest.6b", "onRequest.7", "onRequest.verbatim", "main.2", "main.3", "worker.lookup", "worker.reportBlock",
];

/** Every fragment the set gives for every capability, section, context and line, with its kind, by id. */
function fragmentKinds(rules: OrchestrationRules): Record<string, "C" | "P"> {
  const kinds: Record<string, "C" | "P"> = {};
  const seen = (list: readonly Fragment[]) => {
    expect(new Set(list.map((fragment) => fragment.id)).size, "ids are unique within one text").toBe(list.length);
    for (const fragment of list) {
      if (Object.hasOwn(kinds, fragment.id)) expect(kinds[fragment.id], `${fragment.id} is the same kind everywhere`).toBe(fragment.kind);
      kinds[fragment.id] = fragment.kind;
    }
  };
  for (const caps of [...Object.values(DELEGATION_CAPS), ...Object.values(SYNTHETIC)]) {
    for (const id of SECTION_IDS) for (const worktree of [null, TREE]) seen(rules.section(id, caps, { engine: "codex", worktree }));
    seen(rules.claudeLine(caps));
    seen(rules.onRequestLine(caps));
  }
  seen(rules.claudeMainLine());
  seen(Object.values(rules.workerRules()));
  return kinds;
}
const idsOf = (kinds: Record<string, "C" | "P">, kind: "C" | "P") => Object.keys(kinds).filter((id) => kinds[id] === kind).sort();

describe("which fragments are contract and which are policy", () => {
  it("the contract ids are this constant list, and so are the policy ids", () => {
    const kinds = fragmentKinds(RULES);
    expect(idsOf(kinds, "C")).toEqual([...CONTRACT_IDS].sort());
    expect(idsOf(kinds, "P")).toEqual([...POLICY_IDS].sort());
  });
  it("the dispatch section keeps only .5b as policy (review F1)", () => {
    const kinds = fragmentKinds(RULES);
    expect(Object.keys(kinds).filter((id) => id.startsWith("dispatch.") && kinds[id] === "P")).toEqual(["dispatch.5b"]);
  });
  it("flipping one contract fragment to policy fails the check", () => {
    const flipped: OrchestrationRules = {
      ...RULES,
      section: (id, caps, ctx) => RULES.section(id, caps, ctx).map((fragment) => fragment.id === "dispatch.6" ? { ...fragment, kind: "P" as const } : fragment),
    };
    expect(idsOf(fragmentKinds(flipped), "C")).not.toEqual([...CONTRACT_IDS].sort());
    expect(idsOf(fragmentKinds(flipped), "P")).toContain("dispatch.6");
  });
  it("a text keeps its fragments in the same order with the same ids when a policy fragment is replaced", () => {
    const replaced: OrchestrationRules = {
      ...RULES,
      section: (id, caps, ctx) => RULES.section(id, caps, ctx).map((fragment) => fragment.kind === "P" ? { ...fragment, text: "X" } : fragment),
    };
    const base = RULES.section("dispatch", DELEGATION_CAPS.codex, { engine: "codex" });
    const after = replaced.section("dispatch", DELEGATION_CAPS.codex, { engine: "codex" });
    expect(after.map((fragment) => fragment.id)).toEqual(base.map((fragment) => fragment.id));
    expect(after.filter((fragment) => fragment.kind === "C")).toEqual(base.filter((fragment) => fragment.kind === "C"));
  });
});

describe("the default worker choice", () => {
  it("is the coordinator's own engine, covers the engine only (never a model) and shows in the text", () => {
    for (const engine of ENGINES) {
      expect(RULES.workerDefaults(engine)).toEqual({ workerEngine: engine });
      expect(Object.keys(RULES.workerDefaults(engine))).toEqual(["workerEngine"]);
    }
    const fragment = RULES.section("runDispatch", DELEGATION_CAPS.agy, { engine: "agy" }).find((candidate) => candidate.id === "runDispatch.2a");
    expect(fragment).toEqual({ id: "runDispatch.2a", kind: "P", text: "The default worker engine is agy;" });
  });
});
