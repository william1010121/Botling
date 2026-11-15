/// <reference types="node" />
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inlineTokens } from "../../../Web/kit/build.mjs";
import { readStylesCss, stylesCssPath } from "./helpers/styles-css";

// desktop/src/renderer/styles.css is cut into desktop/src/renderer/styles/NN-*.css (M7-S79). The stylesheet the app
// serves must stay the same bytes: the hashes are of the one-file styles.css at a9e00535, raw, with tokens.css and the
// sections put in as the app builds it (before ModelPicker.css is added), and as the whole out/renderer/styles.css
// (built, ModelPicker.css behind it).
const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const RAW_BEFORE = "48a8c99006c9a80a70cc9640e050d913379eb0e83def29ce4a3388cb3ec5ae05";
const BUILT_BEFORE = "796903e54d635ae3fff71ed930de4f7edbe2038b9f7cdd07e9cf311cdf44686d";
const sectionsDir = join(__dirname, "../../src/renderer/styles");
const sections = () => readdirSync(sectionsDir).filter((name) => name.endsWith(".css")).sort();

describe("styles.css cut into sections", () => {
  it("reads back, for the tests, as the one-file styles.css was", () => {
    expect(sha256(readStylesCss())).toBe(RAW_BEFORE);
  });

  it("builds to the same bytes as before the cut: the renderer's styles.css is the one-file text with tokens.css put in, then ModelPicker.css", () => {
    const modelPicker = readFileSync(join(__dirname, "../../src/renderer/ModelPicker.css"));
    const built = Buffer.concat([Buffer.from(inlineTokens(readFileSync(stylesCssPath, "utf8"), stylesCssPath)), Buffer.from("\n"), modelPicker]);
    expect(sha256(built)).toBe(BUILT_BEFORE);
  });

  it("is what the renderer build writes: out/renderer/styles.css of a real build is the one-file bytes", async () => {
    const { buildRenderer } = await import(join(__dirname, "../../build-renderer.mjs"));
    const outdir = mkdtempSync(join(tmpdir(), "botling-styles-split-"));
    try {
      await buildRenderer({ outdir });
      expect(sha256(readFileSync(join(outdir, "styles.css")))).toBe(BUILT_BEFORE);
    } finally { rmSync(outdir, { recursive: true, force: true }); }
  }, 60_000);

  it("keeps only imports in styles.css, one section file per import in file order, none over 800 lines", () => {
    const lines = readFileSync(stylesCssPath, "utf8").trimEnd().split("\n");
    expect(lines[0]).toMatch(/^@import "[./]*Web\/src\/tokens\.css";$/);
    expect(lines.every((line) => /^@import "[\w./-]+\.css";$/.test(line))).toBe(true);
    const names = sections();
    expect(names.length).toBe(4);
    expect(lines.slice(1)).toEqual(names.map((name) => `@import "./styles/${name}";`));
    for (const name of names) expect(readFileSync(join(sectionsDir, name), "utf8").split("\n").length, name).toBeLessThan(800);
  });

  it("gives the tests the rules of every section, so a check that a rule is absent looks at something", () => {
    const css = readStylesCss();
    expect(css).not.toContain('@import "./styles/');
    for (const marker of [".shell { height: 100%", ".new-bot {", ".plugin-slot-frame {", ".bp-top {", ".theme-thumb-dark"]) expect(css, marker).toContain(marker);
  });
});
