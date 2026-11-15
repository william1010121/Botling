import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// M7-S00: scripts/check-move.mjs on a fixture repository (a moved block, a moved-and-edited block, new code, a rename).
// The script runs as a process, the way the split cards and their reviewers run it.
const script = resolve(__dirname, "../../scripts/check-move.mjs");

let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" }).trim();
function put(path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}
function commit(): string {
  git("add", "-A");
  git("commit", "-q", "-m", "x");
  return git("rev-parse", "HEAD");
}
type Row = { path: string; movedIn: number; movedOut: number; changed: number; added: number; ignored: number };
type Out = { code: number | null; err: string; text: string; json: { rows: Row[]; total: Omit<Row, "path">; skipped: number; ok: boolean } | null };
function check(range: string, ...extra: string[]): Out {
  const r = spawnSync(process.execPath, [script, range, "--root", repo, ...extra], { encoding: "utf8" });
  let json = null;
  if (extra.includes("--json") && r.stdout.trim().startsWith("{")) json = JSON.parse(r.stdout);
  return { code: r.status, err: r.stderr, text: r.stdout, json };
}
const row = (out: Out, path: string) => out.json!.rows.find((x) => x.path === path)!;

const BASE_A = `import { x } from "./x";
import {
  p,
  q,
} from "./pq";

export class A {
  x = 1;

  one(): number {
    const v = this.x + 1;
    if (v > 3) {
      return v * 2;
    }
    return v;
  }

  two(): string {
    const s = String(this.x);
    return s.padStart(4, "0");
  }

  keep(): void {
    this.log("keep");
  }
}
`;
// The two methods, as the new class holds them: same lines, one level less deep.
const MOVED = `  one(): number {
    const v = this.x + 1;
    if (v > 3) {
      return v * 2;
    }
    return v;
  }

  two(): string {
    const s = String(this.x);
    return s.padStart(4, "0");
  }
`;
const HEAD_A = `import { x } from "./x";
import { B } from "./b";

export class A {
  x = 1;

  keep(): void {
    this.log("keep");
  }
}
export { B } from "./b";
`;
let base: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "check-move-"));
  git("init", "-q");
  put("src/a.ts", BASE_A);
  base = commit();
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("check-move", () => {
  it("a block moved to a new file, one level less deep, with import and re-export lines changed: nothing changed", () => {
    put("src/a.ts", HEAD_A);
    put("src/b.ts", `import { x } from "./x";\nimport type { Q } from "./pq";\n\nexport class B {\n${MOVED.replace(/^ {2}/gm, "")}}\n`);
    const head = commit();
    const r = check(`${base}..${head}`, "--json");
    expect(r.code).toBe(0);
    expect(r.json!.total.changed).toBe(0);
    // 11 lines of methods moved; the class line and the class's closing brace are new (the three braces deleted are used up)
    expect(row(r, "src/b.ts")).toMatchObject({ changed: 0, added: 2, movedIn: 11 });
    expect(row(r, "src/a.ts")).toMatchObject({ changed: 0, movedOut: 11, added: 0 });
    expect(row(r, "src/b.ts").ignored).toBe(4); // two import lines and two blank lines
    expect(r.json!.ok).toBe(true);
  });

  it("a moved block with one edited line: one line changed; it fails with the default limit and passes with a limit of 1", () => {
    put("src/a.ts", HEAD_A);
    put("src/b.ts", `export class B {\n${MOVED.replace("v * 2", "v * 3")}}\n`);
    const head = commit();
    const strict = check(`${base}..${head}`);
    expect(strict.code).toBe(1);
    expect(strict.text).toContain("FAIL: 1 lines changed, the limit is 0");
    const allowed = check(`${base}..${head}`, "--json", "--max-changed", "1");
    expect(allowed.code).toBe(0);
    expect(allowed.json!.total).toMatchObject({ changed: 1, added: 3, movedIn: 10 }); // the old line is changed; its new text, the class line and the class brace are added
  });

  it("new code is added, not moved, and a brace beside new lines does not count as moved", () => {
    put("src/a.ts", BASE_A.replace(MOVED, "")); // delete the two methods outright
    put("src/z.ts", "export function z(n: number) {\n  if (n) {\n    return 1;\n  }\n  return 2;\n}\n");
    const head = commit();
    const r = check(`${base}..${head}`, "--json", "--max-changed", "100");
    expect(row(r, "src/z.ts")).toMatchObject({ movedIn: 0, added: 6 });
    expect(row(r, "src/a.ts").changed).toBeGreaterThan(0);
    expect(row(r, "src/a.ts").movedOut).toBe(0);
  });

  it("deleted code that is nowhere else counts as changed", () => {
    put("src/a.ts", BASE_A.replace('    this.log("keep");\n', ""));
    const head = commit();
    const r = check(`${base}..${head}`, "--json");
    expect(r.code).toBe(1);
    expect(r.json!.total).toMatchObject({ changed: 1, movedIn: 0, added: 0 });
  });

  it("a line deleted twice and added once is matched once", () => {
    put("src/c.ts", "function f(a: number) {\n  if (a) return null;\n  return 1;\n}\nfunction g(a: number) {\n  if (a) return null;\n  return 2;\n}\n");
    const mid = commit();
    put("src/c.ts", "function f(a: number) {\n  return 1;\n}\nfunction g(a: number) {\n  return 2;\n}\n");
    put("src/d.ts", "const k = 1;\n  if (a) return null;\n");
    const head = commit();
    const r = check(`${mid}..${head}`, "--json", "--max-changed", "9");
    expect(r.json!.total).toMatchObject({ movedIn: 1, movedOut: 1, changed: 1 });
  });

  it("a renamed file with the same content is a move", () => {
    renameSync(join(repo, "src/a.ts"), join(repo, "src/a-renamed.ts"));
    const head = commit();
    const r = check(`${base}..${head}`, "--json");
    expect(r.code).toBe(0);
    expect(r.json!.total).toMatchObject({ changed: 0, added: 0 });
    expect(row(r, "src/a-renamed.ts").movedIn).toBeGreaterThan(10);
  });

  it("counts product files only, unless --all", () => {
    put("test/unit/a.test.ts", "expect(1).toBe(1);\n");
    put("notes.md", "# hello\n");
    const head = commit();
    const product = check(`${base}..${head}`, "--json");
    expect(product.json!.rows).toEqual([]);
    expect(product.json!.skipped).toBe(2);
    const all = check(`${base}..${head}`, "--json", "--all");
    expect(all.json!.rows.map((r) => r.path)).toEqual(["notes.md", "test/unit/a.test.ts"]);
    expect(all.json!.total.added).toBe(2);
  });

  it("a pathspec after -- narrows the range to those files", () => {
    put("src/m.ts", "const m = 1;\n");
    put("src/n.ts", "const n = 1;\n");
    const head = commit();
    const r = check(`${base}..${head}`, "--json", "--", "src/m.ts");
    expect(r.json!.rows.map((x) => x.path)).toEqual(["src/m.ts"]);
  });

  it("an import statement split over lines is ignored, a call to import() is not", () => {
    put("src/a.ts", BASE_A.replace('import {\n  p,\n  q,\n} from "./pq";', 'import {\n  p,\n  q,\n  r,\n} from "./pq";\nconst lazy = import("./lazy");'));
    const head = commit();
    const r = check(`${base}..${head}`, "--json", "--max-changed", "9");
    expect(r.json!.total).toMatchObject({ added: 1, changed: 0 }); // the dynamic import() line
    expect(r.json!.total.ignored).toBe(1); // `r,` inside the import statement (a hunk of 0 context lines does not show the statement's other lines)
  });

  it("refuses a bad range, a revision that is an option, and an unknown revision", () => {
    expect(check("HEAD").code).toBe(2);
    expect(check("--output=x..HEAD").code).toBe(2);
    expect(check(`${base}..no-such-branch`).code).toBe(2);
    expect(check(`${base}...HEAD`).code).toBe(2);
    expect(check(`-x..HEAD`).code).toBe(2);
  });
});
