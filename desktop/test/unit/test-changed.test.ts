// scripts/test-changed.mjs picks the files to test from git: committed changes against the base,
// plus staged, unstaged and untracked work. Run in a throwaway repo with BOTLING_TEST_CHANGED_LIST=1,
// which prints the relevant files and stops before the typecheck.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = join(__dirname, "..", "..", "scripts", "test-changed.mjs");
let repo = "";
afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

const git = (...args: string[]) => {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
};
const write = (path: string, text = "export {};\n") => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
};

describe("test:changed file selection", () => {
  it("counts untracked files in desktop/ and Web/, with modified ones", () => {
    repo = mkdtempSync(join(tmpdir(), "test-changed-"));
    git("init", "-q");
    mkdirSync(join(repo, "desktop", "scripts"), { recursive: true });
    copyFileSync(script, join(repo, "desktop", "scripts", "test-changed.mjs"));
    write("desktop/src/old.ts");
    write("desktop/test/unit/old.test.ts");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    write("desktop/src/old.ts", "export const x = 1;\n");
    write("desktop/test/unit/new.test.ts");
    write("desktop/src/core/new.ts");
    write("Web/src/new.ts");
    write("desktop/notes.txt", "not a source\n");

    const result = spawnSync(process.execPath, [join(repo, "desktop", "scripts", "test-changed.mjs")], {
      cwd: join(repo, "desktop"), encoding: "utf8", env: { ...process.env, BOTLING_TEST_CHANGED_LIST: "1" },
    });
    expect(result.status, result.stderr).toBe(0);
    const listed = result.stdout.split("\n").filter((line) => line.startsWith("  ")).map((line) => line.trim()).sort();
    expect(listed).toEqual(["Web/src/new.ts", "desktop/src/core/new.ts", "desktop/src/old.ts", "desktop/test/unit/new.test.ts"]);
  });
});
