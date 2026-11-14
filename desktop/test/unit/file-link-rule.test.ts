// A file or folder a bot points the user to must be a link that opens (2026-11-14, the user: a reply ended with
// "完整分鏡表在 `animations/history_17c/route_a_map/v4/storyboard.md`", grey text nothing could open). Every set of
// instructions that tells a bot "[name](url) is drawn as a clickable chip" also tells it to link files and folders
// with their full path, and every worker is told to hand back full absolute paths so its bot can link them.
import { describe, expect, it } from "vitest";
import { botPrompts, desktopPrompts } from "../../src/core/prompts";
import { CLAUDE_WORKER_POLICY } from "../../src/core/agent/claude-workers";

const CHIP = "the app draws it as a clickable chip";
const FILE_LINK = /\[short name\]\(file:\/\/full absolute path\), never as a bare or relative path/;
const WORKER_PATHS = /full absolute paths/;

const ENGINES = ["claude", "codex", "agy"] as const;
const KINDS = ["main", "manager", "bot", "sub"] as const;
const heads = { handoffs: true, limits: { handoffs: 3, review: 2, discussion: 2 } };

function render(engine: typeof ENGINES[number], kind: typeof KINDS[number], tree: string | null, h: typeof heads | null) {
  const role = kind === "sub" ? "bot" as const : kind;
  const profile = {
    id: `${kind}-id`, name: "P", role, folder: "/p/repo", memoryPath: ".bot/memory.md",
    job: kind === "bot" || kind === "sub" ? "Read news" : null, instructions: "X", parent: kind === "sub" ? "manager-id" : null,
  };
  const prompts = botPrompts({ profile, engine, heads: h, language: "en", workingFolder: tree, parentName: kind === "sub" ? "Proj" : null });
  return { prompts, desktop: desktopPrompts(prompts, profile, engine, true), native: desktopPrompts(prompts, profile, engine, false) };
}

describe("file and folder mentions are links with a full path", () => {
  for (const engine of ENGINES) for (const kind of KINDS) for (const tree of [null, "/w/repo-fix"]) for (const h of [null, heads]) {
    it(`${engine}/${kind}/${tree ? "worktree" : "folder"}/${h ? "heads" : "solo"}`, () => {
      const { prompts, desktop, native } = render(engine, kind, tree, h);
      // Claude and Codex heads have the chip rule; the test must not pass by finding nothing to check.
      if (engine !== "agy") expect(prompts.system).toContain(CHIP);
      for (const system of [prompts.system, desktop.system, native.system]) {
        if (system.includes(CHIP)) expect(system).toMatch(FILE_LINK);
      }
      // Codex and Antigravity workers both get codexWorkerSystem.
      expect(desktop.codexWorkerSystem).toMatch(WORKER_PATHS);
    });
  }

  it("a Claude worker hands back full absolute paths", () => {
    expect(CLAUDE_WORKER_POLICY).toMatch(WORKER_PATHS);
  });
});
