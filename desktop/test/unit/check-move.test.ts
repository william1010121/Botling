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

  it("an import statement split over lines is ignored, a dynamic import() line is counted", () => {
    put("src/a.ts", BASE_A.replace('import {\n  p,\n  q,\n} from "./pq";', 'import {\n  p,\n  q,\n  r,\n} from "./pq";\nconst lazy = import("./lazy");'));
    const head = commit();
    const r = check(`${base}..${head}`, "--json", "--max-changed", "9");
    expect(r.json!.total).toMatchObject({ added: 1, changed: 0 }); // the dynamic import() line
    expect(r.json!.total.ignored).toBe(1); // `r,` inside the import statement (a hunk of 0 context lines does not show the statement's other lines)
  });

  it("an `export { name };` list is no re-export: the code after it is not swallowed by a later import line", () => {
    put("src/e.ts", 'export { local };\nconst middle = 1;\nimport tail from "./tail";\n');
    const mid = commit();
    put("src/e.ts", 'export { local };\nconst middle = 2;\nimport tail from "./tail";\n');
    const head = commit();
    const r = check(`${mid}..${head}`, "--json", "--max-changed", "9");
    expect(r.json!.total).toMatchObject({ changed: 1, added: 0, ignored: 0 }); // the old line is changed; its new text replaces it in the same hunk
  });

  // A moved block must keep its lines in order and its lines together: the lines match as a multiset otherwise, and a
  // swap, a statement moved out of its block, an inserted or a doubled line all read as "moved, 0 changed".
  const RUN = `  run(items: number[]): number {
    let total = 0;
    const limit = this.limit();
    for (const it of items) {
      if (it > limit) {
        total += it;
      }
    }
    this.save(total);
    this.notify(total);
    return total;
  }
`;
  const withRun = (a: string) => `export class A {\n${a}\n  other(): void {\n    this.log("a");\n  }\n}\n`;
  function moveRun(newRun: string): Out {
    put("src/r.ts", withRun(RUN));
    const from = commit();
    put("src/r.ts", withRun("").replace("\n\n", "\n"));
    put("src/r2.ts", `export class B {\n${newRun}}\n`);
    const to = commit();
    return check(`${from}..${to}`, "--json");
  }
  const edit = (f: (lines: string[]) => void) => { const l = RUN.split("\n").slice(0, -1); f(l); return l.join("\n") + "\n"; };

  it("the block moved in order, with its blank-line and indentation changes only: nothing changed (the control of the cases below)", () => {
    const r = moveRun(RUN);
    expect(r.json!.total.changed).toBe(0);
    expect(r.code).toBe(0);
  });

  it.each([
    ["two statements swapped", (l: string[]) => { [l[8], l[9]] = [l[9], l[8]]; }],
    ["two declarations swapped", (l: string[]) => { [l[1], l[2]] = [l[2], l[1]]; }],
    ["a statement moved out of its if block", (l: string[]) => { [l[5], l[6]] = [l[6], l[5]]; }],
    ["a statement moved into the loop", (l: string[]) => { l.splice(8, 1); l.splice(6, 0, "      this.save(total);"); }],
    ["a line inserted", (l: string[]) => { l.splice(9, 0, "    this.reset();"); }],
    ["a line inserted before the closing brace", (l: string[]) => { l.splice(l.length - 1, 0, "    this.reset();"); }],
    ["a line doubled", (l: string[]) => { l.splice(5, 0, l[5]); }],
  ])("%s inside a moved block is a change", (_name, mutate) => {
    const r = moveRun(edit(mutate));
    expect(r.json!.total.changed).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });

  it("two lines swapped inside one file are a change; a block of three or more lines moved inside a file is a move", () => {
    put("src/s.ts", "function f() {\n  a();\n  b();\n  c();\n}\nfunction g() {\n  d1();\n  d2();\n  d3();\n}\n");
    const from = commit();
    put("src/s.ts", "function f() {\n  a();\n  c();\n  b();\n}\nfunction g() {\n  d1();\n  d2();\n  d3();\n}\n");
    const swapped = commit();
    expect(check(`${from}..${swapped}`).code).toBe(1);
    put("src/s.ts", "function g() {\n  d1();\n  d2();\n  d3();\n}\nfunction f() {\n  a();\n  b();\n  c();\n}\n");
    const reordered = commit();
    const r = check(`${from}..${reordered}`, "--json");
    expect(r.json!.total.changed).toBe(0);
  });

  it("members taken from two places of a file and put in the other order in the new file are a move", () => {
    put("src/m1.ts", "function f() {\n  a();\n  b();\n}\nconst keep = 1;\nfunction g() {\n  c();\n  d();\n}\n");
    const from = commit();
    put("src/m1.ts", "const keep = 1;\n");
    put("src/m2.ts", "function g() {\n  c();\n  d();\n}\nfunction f() {\n  a();\n  b();\n}\n");
    const to = commit();
    expect(check(`${from}..${to}`, "--json").json!.total).toMatchObject({ changed: 0, added: 0, movedIn: 8 });
  });

  it("a line taken from one moved function and put into another is a change, also when the two were separate hunks in the base", () => {
    const P = (audit: string) => `export function p() {\n  const p1 = load();\n  const p2 = parse(p1);\n${audit}  const p3 = send(p2);\n  return p3;\n}\n`;
    const Q = (audit: string) => `export function q() {\n  const q1 = open();\n  const q2 = read(q1);\n${audit}  const q3 = close(q2);\n  return q3;\n}\n`;
    const KEEP = "export function keep() {\n  return 1;\n}\n";
    put("src/a.ts", P("  audit();\n") + KEEP + Q(""));
    const from = commit();
    put("src/a.ts", KEEP);
    put("src/p.ts", P(""));
    put("src/q.ts", Q("  audit();\n"));
    const to = commit();
    const r = check(`${from}..${to}`, "--json");
    expect(r.json!.total.changed).toBe(2); // the line is gone from p() and new in q()
    expect(r.code).toBe(1);
  });

  describe("real-move shapes stay at 0 changed", () => {
    const body = (name: string, n: number) => `  ${name}(): number {\n${Array.from({ length: n }, (_, i) => `    this.step${i}(${name});`).join("\n")}\n    return ${n};\n  }\n`;
    const cls = (...parts: string[]) => `export class A {\n${parts.join("\n")}}\n`;
    const none = (from: string, to: string) => { const r = check(`${from}..${to}`, "--json"); expect(r.json!.total.changed).toBe(0); expect(r.code).toBe(0); return r; };

    it("two separate regions gathered into a new file in the other order, with a glue line between", () => {
      put("src/b.ts", cls(body("one", 6), body("keep", 3), body("two", 5), body("last", 4)));
      const from = commit();
      put("src/b.ts", cls(body("keep", 3), body("last", 4)));
      put("src/parts.ts", `export class Parts {\n${body("two", 5)}  glue(): void {}\n${body("one", 6)}}\n`);
      none(from, commit());
    });

    it("a block moved to a new file with a delegate left in place", () => {
      put("src/b.ts", cls(body("one", 8), body("keep", 3)));
      const from = commit();
      put("src/b.ts", cls("  one(): number {\n    return new Moved().one();\n  }\n", body("keep", 3)));
      put("src/moved.ts", `export class Moved {\n${body("one", 8)}}\n`);
      const r = none(from, commit());
      expect(r.json!.total.movedIn).toBeGreaterThan(8);
    });

    it("a stretch of a method taken out into a helper below it, with a call left behind", () => {
      put("src/b.ts", cls(body("one", 8), body("keep", 3)));
      const from = commit();
      const lines = body("one", 8).split("\n");
      const taken = lines.slice(2, 6);
      const rest = [...lines.slice(0, 2), "    this.helper();", ...lines.slice(6)].join("\n");
      put("src/b.ts", cls(rest, `  helper(): void {\n${taken.join("\n")}\n  }\n`, body("keep", 3)));
      none(from, commit());
    });

    it("two short methods swapped", () => {
      put("src/b.ts", cls(body("one", 2), body("two", 3), body("keep", 3)));
      const from = commit();
      put("src/b.ts", cls(body("two", 3), body("one", 2), body("keep", 3)));
      none(from, commit());
    });
  });

  it("refuses a bad range, a revision that is an option, and an unknown revision", () => {
    expect(check("HEAD").code).toBe(2);
    expect(check(`${base}..no-such-branch`).code).toBe(2);
    expect(check(`${base}...HEAD`).code).toBe(2);
    for (const range of ["-x..HEAD", `${base}..--all`]) {
      const r = check(range);
      expect(r.code, range).toBe(2);
      expect(r.err, range).toContain("Not a revision");
    }
  });
});
