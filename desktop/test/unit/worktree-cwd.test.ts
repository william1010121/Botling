import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { botPrompts, codexWorkerInstructions } from "../../src/core/prompts";
import { DevBuilds } from "../../src/core/app-swap";
import { desktop } from "../helpers";

const FOLDER = "/p/repo", TREE = "/w/repo-fix";
const heads = { handoffs: true, limits: { handoffs: 3, review: 2, discussion: 2 } };
const profile = (role: "main" | "manager" | "bot") => ({ name: "P", role, folder: FOLDER, memoryPath: ".bot/memory.md", job: role === "bot" ? "Read news" : null, instructions: "X" });
const snapshot = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "prompts-no-worktree.json"), "utf8"));

describe("prompts without an app worktree are unchanged", () => {
  for (const role of ["main", "manager", "bot"] as const) for (const engine of ["claude", "codex", "agy"] as const) for (const h of [null, heads]) {
    const key = `${role}/${engine}/${h ? "heads" : "solo"}`;
    it(key, () => {
      expect(botPrompts({ profile: profile(role), engine, heads: h, language: "en" })).toEqual(snapshot[key]);
      expect(botPrompts({ profile: profile(role), engine, heads: h, language: "en", workingFolder: null })).toEqual(snapshot[key]);
    });
  }
  it("worker instructions", () => {
    expect(codexWorkerInstructions(profile("manager"), "en")).toBe(snapshot.worker);
    expect(codexWorkerInstructions(profile("manager"), "en", null)).toBe(snapshot.worker);
  });
});

describe("prompts with an app worktree name it", () => {
  const withTree = (engine: "claude" | "codex" | "agy", role: "manager" | "main" = "manager") => botPrompts({ profile: profile(role), engine, heads: null, language: "en", workingFolder: TREE });
  it("the worker is told the working folder is the worktree, not the project", () => {
    const text = withTree("codex").codexWorkerSystem;
    expect(text).toContain(`Working folder: ${TREE}`);
    expect(text).not.toContain(`Working folder: ${FOLDER}`);
    expect(text).toMatch(/relative paths/);
    expect(text).toMatch(/do not create your own/i);
  });
  it("Antigravity says its working folder is the worktree", () => {
    const text = withTree("agy").system;
    expect(text).toContain(`Working folder: ${TREE}`);
    expect(text).not.toContain(`Working folder: ${FOLDER}`);
    expect(withTree("agy").codexWorkerSystem).toContain(`Working folder: ${TREE}`);
  });
  it("the manager is not told its working folder is the project", () => {
    const text = withTree("claude").system;
    expect(text).not.toContain("your working folder is this project");
    expect(text).toContain(TREE);
    expect(text).toContain(FOLDER);
  });
  it("the Codex and Antigravity coordinators do not tell workers to create worktrees", () => {
    for (const engine of ["codex", "agy"] as const) {
      const text = withTree(engine).system;
      expect(text).not.toContain("its own isolated git worktree");
      expect(text).toContain(TREE);
      expect(text).toMatch(/Do not tell workers to create their own git worktrees/);
    }
  });
  it("the main bot has no worktree and is not touched", () => {
    expect(withTree("claude", "main")).toEqual(botPrompts({ profile: profile("main"), engine: "claude", heads: null, language: "en" }));
  });
});

describe("developer briefing", () => {
  const builds = new DevBuilds({ developer: () => ({ id: "D" }), devWork: () => "/work" } as never);
  const bot = { id: "D", profile: { folder: FOLDER } } as never;
  it("only tells an agent without a worktree to make one with an absolute path", () => {
    expect(builds.briefing(bot, false)).toContain("git worktree add /work/<short-task>");
    const text = builds.briefing(bot, true);
    expect(text).not.toContain("git worktree add");
    expect(text).not.toContain("from the main folder, after merging");
  });
});
