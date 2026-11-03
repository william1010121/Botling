// What the coordinator is told about delegation, frozen byte for byte for every engine, with and without an app
// worktree. Any change to it changes the prompt hash and gives every bot a new session, so the text may change
// only on purpose: regenerate test/fixtures/delegation-prompts-golden.json then, and say so in the commit.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/core/agent/agy-capabilities", async (original) => ({ ...await original<any>(), agyWorkerRuntimeEnabled: () => true }));
import { botPrompts, desktopPrompts } from "../../src/core/prompts";
import { desktop } from "../helpers";

const FOLDER = "/p/repo", TREE = "/w/repo-fix";
const ENGINES = ["claude", "codex", "agy"] as const;
const heads = { handoffs: true, limits: { handoffs: 3, review: 2, discussion: 2 } };
const profile = (role: "main" | "manager" | "bot") => ({ id: `${role}-id`, name: "P", role, folder: FOLDER, memoryPath: ".bot/memory.md", job: role === "bot" ? "Read news" : null, instructions: "X" });
const golden = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "delegation-prompts-golden.json"), "utf8"));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function render(engine: typeof ENGINES[number], role: "main" | "manager" | "bot", tree: string | null, h: typeof heads | null) {
  const p = profile(role);
  const prompts = botPrompts({ profile: p, engine, heads: h, language: "en", workingFolder: tree });
  return { prompts, desktop: desktopPrompts(prompts, p, engine, true), native: desktopPrompts(prompts, p, engine, false) };
}

describe("the delegation prompt is byte-identical", () => {
  for (const engine of ENGINES) for (const tree of [null, TREE]) {
    const key = `${engine}/${tree ? "worktree" : "folder"}`;
    it(key, () => {
      const { desktop } = render(engine, "manager", tree, null);
      expect(desktop.system).toBe(golden.text[key].system);
      expect(desktop.codexWorkerSystem).toBe(golden.text[key].codexWorkerSystem);
    });
  }
  it("every role, engine, worktree and heads choice", () => {
    const digests: Record<string, string> = {};
    for (const engine of ENGINES) for (const role of ["main", "manager", "bot"] as const) for (const tree of [null, TREE]) for (const h of [null, heads]) {
      const { prompts, desktop, native } = render(engine, role, tree, h);
      const key = `${engine}/${role}/${tree ? "worktree" : "folder"}/${h ? "heads" : "solo"}`;
      for (const [field, text] of Object.entries(prompts)) digests[`${key}/${field}`] = sha(text);
      digests[`${key}/desktop`] = sha(desktop.system);
      digests[`${key}/native`] = sha(native.system);
    }
    expect(digests).toEqual(golden.digests);
  });
});
