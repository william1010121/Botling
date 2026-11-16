// M7-S60b (S59 review F2): the bridge-setter rule of check-lines.mjs also sees a `set` accessor that is not first on its line
// (`get a() { ... } set a(v) { ... }`), a `static` / `override` one, and does not trip on the words "set x (" in a string or a comment.
// Subdirectories of core/bot/ stay outside the rule: bot-foreign-writes-probes.test.ts pins that (`core/bot/inner/deep.ts`).
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(__dirname, "../../scripts/check-lines.mjs");

function flaggedIn(text: string): string[] {
  const repo = mkdtempSync(join(tmpdir(), "setter-forms2-"));
  try {
    const path = "desktop/src/core/bot/forms.ts";
    mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), text);
    const baseline = join(repo, "baseline.json"); writeFileSync(baseline, JSON.stringify({ files: {} }));
    execFileSync("git", ["-C", repo, "init", "-q"]); execFileSync("git", ["-C", repo, "add", "-A"]);
    const result = spawnSync("node", [script, "--root", repo, "--baseline", baseline], { encoding: "utf8" });
    return result.stderr.split("\n").filter((line) => line.includes("a set accessor in a bridge block")).map((line) => line.replace(/^FAIL: desktop\/src\/core\/bot\/forms\.ts:/, "").replace(/: .*$/, ""));
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

describe("check-lines: the bridge-setter rule sees more forms (S60b)", () => {
  it("flags a getter and its setter on one line, and a setter after other code", () => {
    expect(flaggedIn(["class C {", "  get a() { return this.host.a; } set a(v: number) { this.host.a = v; }", "  x = 1; set b(v: number) { this.host.b = v; }", "}", ""].join("\n"))).toEqual(["2", "3"]);
  });

  it("flags static, override and static override setters, with any visibility before them", () => {
    expect(flaggedIn(["class C {", "  static set a(v: number) {}", "  override set b(v: number) {}", "  public static set c(v: number) {}", "  protected override set d(v: number) {}", "}", ""].join("\n"))).toEqual(["2", "3", "4", "5"]);
  });

  it("does not flag the words `set x (` in a string, a template, a line comment or a block comment", () => {
    expect(flaggedIn([
      "class C {",
      "  run() { this.log(`owner not set yet (${1})`); this.log(\"set a (b)\"); this.log('set c (d)'); }",
      "  // a getter and set e(v) are gone",
      "  go() { return 1; } // set f(v) was here",
      "  /* set g(v) */ stay() { return 2; }",
      "  /**",
      "   * set h(v) was a bridge setter",
      "   */",
      "  after() { return 3; }",
      "}",
      "",
    ].join("\n"))).toEqual([]);
  });

  it("still flags a setter after a closed block comment on its line", () => {
    expect(flaggedIn(["class C {", "  /* old */ set a(v: number) {}", "}", ""].join("\n"))).toEqual(["2"]);
  });
});
