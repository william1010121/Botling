// ADR-006 M1: PLUGINS.md is a small index; every file it names exists, nothing else is orphaned, and the
// app writes them all into the library.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { GUIDE_FOLDER, pluginGuideFiles, pluginGuideIndex } from "../../src/core/plugin-guide-text";
import { prepareLibrary } from "../../src/core/maintainer";
import { maintainerInstructions } from "../../src/core/maintainer-text";

const referenced = (index: string) => [...index.matchAll(/`(plugins-guide\/[^`]+)`/g)].map((match) => match[1].slice(GUIDE_FOLDER.length + 1));

describe("the plugin guide index", () => {
  it("names only files that exist, and every reference file is named by the index", () => {
    const files = pluginGuideFiles();
    const named = new Set(referenced(pluginGuideIndex()));
    expect(named.size).toBeGreaterThan(8);
    for (const path of named) expect(Object.keys(files), path).toContain(path);
    for (const path of Object.keys(files).filter((path) => path.startsWith("reference/"))) expect(named.has(path), path).toBe(true);
    for (const content of Object.values(files)) expect(content.length).toBeGreaterThan(50);
  });

  it("stays small (the old single guide was ~18 KB, read in full on every run)", () => {
    expect(Buffer.byteLength(pluginGuideIndex("/some/built-in/plugins"), "utf8")).toBeLessThan(5000);
  });

  it("is what Maintainer's instructions point at, and the app writes the index and every file it names", () => {
    expect(maintainerInstructions("/lib", null, null)).toContain("/lib/PLUGINS.md");
    const root = tempDir("plugin-guide");
    prepareLibrary(root);
    const library = join(root, "plugins");
    const index = readFileSync(join(library, "PLUGINS.md"), "utf8");
    for (const path of referenced(index)) expect(existsSync(join(library, GUIDE_FOLDER, path)), path).toBe(true);
    // Rewritten when it drifts.
    const file = join(library, GUIDE_FOLDER, "reference/web-part.md");
    expect(readFileSync(file, "utf8")).toBe(pluginGuideFiles()["reference/web-part.md"]);
  });

  it("keeps every API fact of the old guide reachable (the references carry the old sections)", () => {
    const all = Object.values(pluginGuideFiles()).join("\n");
    for (const needle of ["ccb.composer", "ccb.hooks.beforeSend", "ccb.bots.create", "claude plugin validate --strict", "ccb.size", "ccb.save", "ccb.runDetail", "<install>source</install>", "Revert to previous version"]) {
      expect(all, needle).toContain(needle);
    }
  });
});
