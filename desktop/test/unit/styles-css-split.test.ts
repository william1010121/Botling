/// <reference types="node" />
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inlineTokens } from "../../../Web/kit/build.mjs";
import { readStylesCss, stylesCssPath } from "./helpers/styles-css";

// desktop/src/renderer/styles.css is cut into desktop/src/renderer/styles/NN-*.css (M7-S79). The stylesheet the app
// serves must stay the same bytes as the one-file styles.css at a9e00535 (RAW_BEFORE: raw, with tokens.css and the
// sections put in as the app builds it, before ModelPicker.css is added; BUILT_BEFORE: the whole out/renderer/styles.css,
// ModelPicker.css behind it), EXCEPT for the additions listed below. Each later card that adds a rule to the shell's
// stylesheet lists it here by its exact text: parts 01-04 are pinned to the cut (an edit that is not listed, a moved
// rule or a changed byte fails), and a new section is pinned by its own hash. To add CSS, add its entry; never loosen a hash.
const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const RAW_BEFORE = "48a8c99006c9a80a70cc9640e050d913379eb0e83def29ce4a3388cb3ec5ae05";
const BUILT_BEFORE = "796903e54d635ae3fff71ed930de4f7edbe2038b9f7cdd07e9cf311cdf44686d";
/** The sections the cut made, in the order the app builds them, with the sha256 of each file at the cut (096c6c0c). */
const CUT = {
  "01-app-chrome-and-settings.css": "556298987da197f0b365721afb10f45cf50b53594d2fc0eb756bfec51eba113c",
  "02-new-bot-and-right-panel.css": "3234b16d342271982dcbcd0cf1705b15238ac93b2466c4cd7642d325113d37e2",
  "03-plugin-block-and-navigation.css": "defecdd8acfcbd1d1d356bca7f1fb4d881135859c4ce7cbcb2abfe1ac0266a90",
  "04-browser-pane-floating-chat-and-storage.css": "85e794ef92c71cc3ae1f5e8ba59c9c818414a0f631498d0e02c09e4196e3491b",
};
/** Text added to a cut section after the cut: exact lines, each once, inside that file (removing them gives the cut's bytes back). */
const ADDED_TEXT: { file: keyof typeof CUT; text: string; by: string }[] = [
  { file: "01-app-chrome-and-settings.css", by: "M7-02c 2718d191", text: ".settings-unavailable { padding: 6px 10px; }\n" },
  { file: "02-new-bot-and-right-panel.css", by: "M7-03a 48806485", text: "/* The shell's line where the bot-panel plugin's part would be (M7-03a). */\n"
    + ".panel-unavailable { font-size: 12px; color: var(--faint); padding: 6px 12px; margin: 0; }\n"
    + ".strip-unavailable { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: var(--faint); }\n" },
];
/** Sections added after the cut, in order after the cut's four, each pinned by the sha256 of its whole file. */
const ADDED_SECTIONS: Record<string, { sha256: string; by: string }> = {
  "05-shell-fallback.css": { by: "M7-07c 9210abef", sha256: "d25895d8ac083d090d5f0b4e1b0ddd6e94082952891f7d3ba569ff325433849e" },
  "06-dynamic-tabs.css": { by: "dynamic tabs", sha256: "90e6c5eacfb14ae45bc8e961f528d09b86ea657479502985c4dbc4db2287779d" },
};
const sectionsDir = join(__dirname, "../../src/renderer/styles");
const sections = () => readdirSync(sectionsDir).filter((name) => name.endsWith(".css")).sort();
const EXPECTED_SECTIONS = [...Object.keys(CUT), ...Object.keys(ADDED_SECTIONS)];
const removeOnce = (text: string, part: string, what: string) => {
  const pieces = text.split(part);
  expect(pieces.length - 1, `${what} must appear exactly once`).toBe(1);
  return pieces.join("");
};
/** `text` (the inlined sections, or the built stylesheet) without the listed additions: the cut's bytes. */
const withoutAdditions = (text: string) => {
  let out = text;
  for (const { file, text: added, by } of ADDED_TEXT) out = removeOnce(out, added, `${file}: the text ${by} added`);
  for (const name of Object.keys(ADDED_SECTIONS)) out = removeOnce(out, readFileSync(join(sectionsDir, name), "utf8"), name);
  return out;
};
const withoutAdditionsIn = (file: keyof typeof CUT) => ADDED_TEXT.filter((added) => added.file === file)
  .reduce((text, added) => removeOnce(text, added.text, `${file}: the text ${added.by} added`), readFileSync(join(sectionsDir, file), "utf8"));

describe("styles.css cut into sections", () => {
  it("reads back, for the tests, as the one-file styles.css was", () => {
    expect(sha256(withoutAdditions(readStylesCss()))).toBe(RAW_BEFORE);
  });

  it("builds to the same bytes as before the cut: the renderer's styles.css is the one-file text with tokens.css put in, then ModelPicker.css", () => {
    const modelPicker = readFileSync(join(__dirname, "../../src/renderer/ModelPicker.css"));
    const built = Buffer.concat([Buffer.from(inlineTokens(readFileSync(stylesCssPath, "utf8"), stylesCssPath)), Buffer.from("\n"), modelPicker]);
    expect(sha256(withoutAdditions(built.toString("utf8")))).toBe(BUILT_BEFORE);
  });

  it("is what the renderer build writes: out/renderer/styles.css of a real build is the one-file bytes", async () => {
    const { buildRenderer } = await import(join(__dirname, "../../build-renderer.mjs"));
    const outdir = mkdtempSync(join(tmpdir(), "botling-styles-split-"));
    try {
      await buildRenderer({ outdir });
      expect(sha256(withoutAdditions(readFileSync(join(outdir, "styles.css"), "utf8")))).toBe(BUILT_BEFORE);
    } finally { rmSync(outdir, { recursive: true, force: true }); }
  }, 60_000);

  it("keeps each of the cut's four sections as the cut made it, apart from the listed additions", () => {
    for (const [name, cut] of Object.entries(CUT)) expect(sha256(withoutAdditionsIn(name as keyof typeof CUT)), name).toBe(cut);
  });

  it("pins every section added after the cut by its own hash", () => {
    for (const [name, { sha256: hash, by }] of Object.entries(ADDED_SECTIONS)) expect(sha256(readFileSync(join(sectionsDir, name))), `${name} (${by})`).toBe(hash);
  });

  it("keeps only imports in styles.css, one section file per import in file order, none over 800 lines", () => {
    const lines = readFileSync(stylesCssPath, "utf8").trimEnd().split("\n");
    expect(lines[0]).toMatch(/^@import "[./]*Web\/src\/tokens\.css";$/);
    expect(lines.every((line) => /^@import "[\w./-]+\.css";$/.test(line))).toBe(true);
    const names = sections();
    expect(names).toEqual(EXPECTED_SECTIONS);
    expect(lines.slice(1)).toEqual(names.map((name) => `@import "./styles/${name}";`));
    for (const name of names) expect(readFileSync(join(sectionsDir, name), "utf8").split("\n").length, name).toBeLessThan(800);
  });

  it("gives the tests the rules of every section, so a check that a rule is absent looks at something", () => {
    const css = readStylesCss();
    expect(css).not.toContain('@import "./styles/');
    for (const marker of [".shell { height: 100%", ".new-bot {", ".plugin-slot-frame {", ".bp-top {", ".theme-thumb-dark"]) expect(css, marker).toContain(marker);
  });
});
