import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// desktop/scripts/where.mjs: "where is this symbol" for workers. The fixture is a small project in a temp folder.
const SCRIPT = fileURLToPath(new URL("../../scripts/where.mjs", import.meta.url));

const ALPHA = [
  "export type Id = string;",
  "export const LIMIT = 3;",
  "export function makeThing(n: number): Id {",
  "  const tmpLocal = n + 1;",
  "  return String(tmpLocal);",
  "}",
  "export class Widget {",
  "  render(x: string): void { void x; }",
  "}",
  ...["A", "B", "C", "D", "E", "F", "G", "H"].map((s) => `export const widget${s} = ${s.charCodeAt(0)};`),
  "",
].join("\n");
// 60 call lines: more than the cap of 40 references
const BETA = ["import { makeThing } from \"./alpha\";", ...Array.from({ length: 60 }, (_, i) => `makeThing(${i});`), ""].join("\n");
// named so that it sorts before beta.ts: only the "tests last" order keeps it out of the first 40
const TESTFILE = "import { makeThing } from \"./alpha\";\nmakeThing(0);\n";
const GAMMA = "import { makeThing } from \"./alpha\";\nexport const View = () => <div>{makeThing(1)}</div>;\n";
const INDEX = "export * from \"./alpha\";\nexport { View as MainView } from \"./gamma\";\nexport default class Entry {}\n";
const UI_JS = [
  "function renderPanel(a) {",
  "  return a;",
  "}",
  "export const helper = (x) => x;",
  "renderPanel(1);",
  "helper(2);",
  "",
].join("\n");

let root = "";
let outside = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "where-script-"));
  outside = mkdtempSync(join(tmpdir(), "where-script-outside-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "alpha.ts"), ALPHA);
  writeFileSync(join(root, "src", "beta.ts"), BETA);
  writeFileSync(join(root, "src", "a.test.ts"), TESTFILE);
  writeFileSync(join(root, "src", "gamma.tsx"), GAMMA);
  writeFileSync(join(root, "src", "index.ts"), INDEX);
  writeFileSync(join(root, "src", "ui.js"), UI_JS);
  writeFileSync(join(outside, "secret.ts"), "export const hiddenSymbol = 1;\n");
  symlinkSync(outside, join(root, "src", "linked"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function where(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--root", root], { cwd: root, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const lineOf = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

interface Found {
  name: string; found: true;
  definitions: Array<{ file: string; line: number; kind: string; signature: string; exported: boolean; container?: string }>;
  definitionsOmitted: number;
  references: { total: number; omitted: number; items: Array<{ file: string; line: number; text: string }> };
  scannedFiles: number;
}

describe("where.mjs", () => {
  it("finds a function, a class and a type alias with file, line, kind and signature", () => {
    const fn = where("makeThing", "--json");
    expect(fn.code).toBe(0);
    const f = JSON.parse(fn.out) as Found;
    expect(f.definitions).toHaveLength(1);
    expect(f.definitions[0]).toMatchObject({ file: "src/alpha.ts", line: lineOf(ALPHA, "export function makeThing"), kind: "function", exported: true });
    expect(f.definitions[0].signature).toBe("export function makeThing(n: number): Id");

    const cls = JSON.parse(where("Widget", "--json").out) as Found;
    expect(cls.definitions[0]).toMatchObject({ file: "src/alpha.ts", line: lineOf(ALPHA, "export class Widget"), kind: "class", signature: "export class Widget" });

    const alias = JSON.parse(where("Id", "--json").out) as Found;
    expect(alias.definitions[0]).toMatchObject({ file: "src/alpha.ts", line: 1, kind: "type", signature: "export type Id = string;" });

    const text = where("Widget").out;
    expect(text).toContain(`src/alpha.ts:${lineOf(ALPHA, "export class Widget")}  class  export class Widget`);
  });

  it("finds a method through Class.member and puts the owner's member first; a function's local variable is not a definition", () => {
    const m = JSON.parse(where("Widget.render", "--json").out) as Found;
    expect(m.definitions[0]).toMatchObject({ file: "src/alpha.ts", kind: "method", container: "Widget", line: lineOf(ALPHA, "render(x: string)") });
    const local = where("tmpLocal", "--json");
    expect(local.code).toBe(0);
    const l = JSON.parse(local.out) as Found;
    expect(l.definitions).toHaveLength(0);
    expect(l.references.total).toBe(2);
  });

  it("lists references (a TSX file included), caps them at 40 with the count of the rest, and lists test files last", () => {
    const f = JSON.parse(where("makeThing", "--json").out) as Found;
    // beta.ts: import + 60 calls; gamma.tsx: import + 1 use; the test file: import + 1 call
    expect(f.references.total).toBe(61 + 2 + 2);
    expect(f.references.items).toHaveLength(40);
    expect(f.references.omitted).toBe(f.references.total - 40);
    expect(f.references.items.some((r) => r.file.endsWith(".test.ts"))).toBe(false);
    for (const r of f.references.items) expect(r.file).toBe("src/beta.ts");
    const text = where("makeThing").out;
    expect(text).toContain("References (first 40 of 65):");
    expect(text).toContain("... and 25 more not shown");
    expect(text.split("\n").filter((l) => /^ {2}src\/\S+:\d+ {2}/.test(l)).length).toBe(41); // 40 references + the definition

    const g = JSON.parse(where("View", "--json").out) as Found;
    expect(g.definitions[0]).toMatchObject({ file: "src/gamma.tsx", kind: "function" });
  });

  it("lists the exports of one file with --exports", () => {
    const e = JSON.parse(where("--exports", "src/alpha.ts", "--json").out) as { file: string; exports: Array<{ name: string; kind: string; line: number }> };
    expect(e.file).toBe("src/alpha.ts");
    const names = e.exports.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["Id", "LIMIT", "makeThing", "Widget", "widgetA", "widgetH"]));
    expect(e.exports.find((x) => x.name === "makeThing")).toMatchObject({ kind: "function", line: lineOf(ALPHA, "export function makeThing") });
    expect(e.exports.find((x) => x.name === "Id")?.kind).toBe("type");
    expect(names).not.toContain("tmpLocal");

    const idx = JSON.parse(where("--exports", "src/index.ts", "--json").out) as typeof e;
    expect(idx.exports.map((x) => `${x.kind}:${x.name}`)).toEqual(["re-export:*", "re-export:MainView", "class:Entry"]);
    expect(where("--exports", "src/ui.js").out).toContain("helper");
    expect(where("--exports", "src/ui.js").out).not.toContain("renderPanel");
    expect(where("--exports", "src/nope.ts").code).toBe(2);
  });

  it("exits 1 with 'not found' and at most five close names for an unknown name", () => {
    const typo = where("makeTing");
    expect(typo.code).toBe(1);
    expect(typo.out).toContain("not found: makeTing");
    expect(typo.out).toMatch(/close names: .*makeThing/);

    const many = JSON.parse(where("widget", "--json").out) as { found: boolean; closeNames: string[] };
    expect(where("widget").code).toBe(1);
    expect(many.found).toBe(false);
    expect(many.closeNames).toHaveLength(5);
    expect(many.closeNames[0]).toBe("Widget");

    const nothing = where("qqqqqqqq");
    expect(nothing.code).toBe(1);
    expect(nothing.out).not.toContain("close names");
  });

  it("falls back to a whole-word definition pattern for a .js file", () => {
    const r = JSON.parse(where("renderPanel", "--json").out) as Found;
    expect(r.definitions).toHaveLength(1);
    expect(r.definitions[0]).toMatchObject({ file: "src/ui.js", line: 1, kind: "function", signature: "function renderPanel(a) {" });
    expect(r.references.items).toEqual([{ file: "src/ui.js", line: 5, text: "renderPanel(1);" }]);
    const h = JSON.parse(where("helper", "--json").out) as Found;
    expect(h.definitions[0]).toMatchObject({ file: "src/ui.js", line: 4, kind: "function", exported: true });
    // whole word: "renderPane" is not renderPanel
    expect(where("renderPane").code).toBe(1);
  });

  it("--json is one parseable document with the same facts as the text", () => {
    const r = where("makeThing", "--json");
    expect(r.out.trim().split("\n")).toHaveLength(1);
    const f = JSON.parse(r.out) as Found;
    expect(f).toMatchObject({ name: "makeThing", found: true });
    expect(f.scannedFiles).toBe(6);
    const text = where("makeThing").out;
    expect(text).toContain("makeThing: 1 definition, 65 reference lines");
    expect(JSON.parse(where("makeTing", "--json").out)).toMatchObject({ found: false });
  });

  it("is read only: no file in the fixture changes, none is added, and a symlinked folder is not followed", () => {
    const snapshot = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return snapshot(p);
      const st = statSync(p);
      return [`${p}|${st.size}|${st.mtimeMs}|${createHash("sha1").update(readFileSync(p)).digest("hex")}`];
    });
    const before = snapshot(root);
    where("makeThing"); where("Widget", "--json"); where("--exports", "src/alpha.ts"); where("nothingHere");
    expect(snapshot(root)).toEqual(before);
    expect(snapshot(outside)).toHaveLength(1);
    // src/linked -> outside/secret.ts is never read
    expect(where("hiddenSymbol").code).toBe(1);
  });

  it("refuses a name that is not an identifier and prints a file name with control characters on one line", () => {
    const bad = where("a b");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("not an identifier");
    expect(where().code).toBe(2);
    expect(where("--nope").code).toBe(2);

    const odd = join(root, "src", "ev\nil.ts");
    writeFileSync(odd, "export const oddFileSymbol = 1;\n");
    try {
      const r = where("oddFileSymbol");
      expect(r.code).toBe(0);
      const line = r.out.split("\n").find((l) => l.includes("oddFileSymbol = 1"));
      expect(line).toContain("src/ev\\x0ail.ts:1");
      expect(r.out.split("\n").every((l) => !l.startsWith("il.ts"))).toBe(true);
    } finally { rmSync(odd, { force: true }); }
  });
});
