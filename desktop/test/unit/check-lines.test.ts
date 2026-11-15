import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// M7-S00: scripts/check-lines.mjs on a fixture repository. The script is run as a process, the way CI and the split
// cards run it, so what is tested is its exit code and its output.
const script = resolve(__dirname, "../../scripts/check-lines.mjs");
const realBaseline = resolve(__dirname, "../../scripts/line-baseline.json");

const lines = (n: number, trailingNewline = true) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n") + (trailingNewline ? "\n" : "");

let repo: string;
function put(path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}
function commitAll() {
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "x"]);
}
function baseline(files: Record<string, number>, frozen?: Record<string, string>) {
  put("scripts/line-baseline.json", JSON.stringify(frozen ? { files, frozen } : { files }));
}
function run(...extra: string[]) {
  const r = spawnSync(process.execPath, [script, "--root", repo, "--baseline", join(repo, "scripts/line-baseline.json"), ...extra], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "check-lines-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("check-lines", () => {
  it("passes when no product file is over 800 lines, and counts a file of exactly 800 as fine", () => {
    put("src/ok.ts", lines(800));
    baseline({});
    commitAll();
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("check-lines: ok");
  });

  it("fails a new unlisted file over 800 lines, committed or not", () => {
    put("src/ok.ts", lines(10));
    baseline({});
    commitAll();
    put("src/long.ts", lines(801));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("src/long.ts: 801 lines");
    expect(r.err).toContain("not in the baseline");
    commitAll();
    expect(run().code).toBe(1);
  });

  it("counts a last line without a newline", () => {
    put("src/a.ts", lines(801, false));
    put("src/b.ts", lines(800, false));
    baseline({});
    commitAll();
    const r = run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("src/a.ts: 801 lines");
    expect(r.err).not.toContain("src/b.ts");
  });

  it("lets a listed file stay at its number and fails when it grows by one line", () => {
    put("src/big.ts", lines(900));
    baseline({ "src/big.ts": 900 });
    commitAll();
    expect(run().code).toBe(0);
    put("src/big.ts", lines(901));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("src/big.ts: grew to 901 lines, its baseline is 900");
  });

  it("notes a listed file that got smaller but still passes; at or under 800 the entry must go", () => {
    put("src/big.ts", lines(850));
    baseline({ "src/big.ts": 900 });
    commitAll();
    const small = run();
    expect(small.code).toBe(0);
    expect(small.out).toContain("lower the entry to 850");
    put("src/big.ts", lines(800));
    const done = run();
    expect(done.code).toBe(1);
    expect(done.err).toContain("remove its entry");
  });

  it("frozen file: growing by one line fails and names the reason; shrinking passes; its entry may not be removed", () => {
    const reason = "Botling 2 only, user 2026-11-16: not split";
    put("src/frozen.ts", lines(900));
    baseline({ "src/frozen.ts": 900 }, { "src/frozen.ts": reason });
    commitAll();
    const same = run();
    expect(same.code).toBe(0);
    expect(same.out).toContain(reason);
    put("src/frozen.ts", lines(901));
    const grown = run();
    expect(grown.code).toBe(1);
    expect(grown.err).toContain("src/frozen.ts: frozen");
    expect(grown.err).toContain(reason);
    expect(grown.err).toContain("grew to 901 lines, its baseline is 900");
    put("src/frozen.ts", lines(899));
    const shrunk = run();
    expect(shrunk.code).toBe(0);
    expect(shrunk.out).toContain(reason);
    expect(shrunk.out).not.toContain("lower the entry");
    baseline({}, { "src/frozen.ts": reason });
    const removed = run();
    expect(removed.code).toBe(1);
    expect(removed.err).toContain("its entry is gone from the baseline");
  });

  it("fails an entry whose file is gone", () => {
    put("src/ok.ts", lines(5));
    baseline({ "src/gone.ts": 900 });
    commitAll();
    const r = run();
    expect(r.code).toBe(1);
    expect(r.err).toContain("src/gone.ts: in the baseline but not a product file that exists");
  });

  it("does not count tests, docs, specs, fixtures or other file types", () => {
    for (const path of ["test/unit/a.test.ts", "src/a.test.ts", "src/a.spec.tsx", "spec/x.ts", "specs/y.ts", "docs/z.ts", "src/fixtures/f.ts", "src/data.json", "src/page.html", "node_modules/m/i.js"]) put(path, lines(1200));
    baseline({});
    commitAll();
    expect(run().code).toBe(0);
  });

  it("counts every product extension: ts tsx js mjs css", () => {
    for (const path of ["a.ts", "b.tsx", "c.js", "d.mjs", "e.css"]) put(`src/${path}`, lines(801));
    baseline({});
    commitAll();
    const r = run();
    expect(r.code).toBe(1);
    for (const name of ["a.ts", "b.tsx", "c.js", "d.mjs", "e.css"]) expect(r.err).toContain(`src/${name}: 801 lines`);
  });

  it("refuses a bad --limit and a missing baseline", () => {
    put("src/ok.ts", lines(5));
    baseline({});
    expect(run("--limit", "0").code).toBe(2);
    const r = spawnSync(process.execPath, [script, "--root", repo, "--baseline", join(repo, "nope.json")], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});

describe("line-baseline.json", () => {
  it("lists product files over 800 lines, one per line and sorted by path, so a card edits only its own entry", () => {
    const text = readFileSync(realBaseline, "utf8");
    const parsed = JSON.parse(text) as { files: Record<string, number> };
    const paths = Object.keys(parsed.files);
    expect(paths).toEqual([...paths].sort());
    for (const [path, n] of Object.entries(parsed.files)) {
      expect(Number.isInteger(n) && n > 800, path).toBe(true);
      expect(text.split("\n").filter((line) => line.trim().startsWith(`${JSON.stringify(path)}: ${n}`))).toHaveLength(1);
    }
    expect(parsed.files["desktop/src/main/main.ts"]).toBeGreaterThan(800); // frozen on purpose, never split
    const frozen = (JSON.parse(text) as { frozen?: Record<string, string> }).frozen ?? {};
    expect(frozen["desktop/src/main/main.ts"]).toContain("not split");
    for (const path of Object.keys(frozen)) expect(Object.hasOwn(parsed.files, path), path).toBe(true);
  });
});
