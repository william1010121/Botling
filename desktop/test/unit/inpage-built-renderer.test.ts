// The built renderer.js carries the FE manifest (M7-02c). M7-10a could only check a scratch bundle: nothing imported the loader into
// the app. The shell's in-page host (shell/inpage-host.ts) does now, through `embeddedFeManifest()`, so the real renderer bundle must
// hold the text the manifest file holds: the desktop window's CSP (`connect-src 'none'`) blocks a fetch of the file, so the page
// reads the list it was built with.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildRenderer } from "../../build-renderer.mjs";
import { FE_MANIFEST_FILE } from "../../fe-build-manifest.mjs";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { desktop } from "../helpers";

const out = mkdtempSync(join(tmpdir(), "botling-renderer-build-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("the built renderer.js", () => {
  it("holds the text of fe-build-manifest.json, in the form the bundler printed the string (so the page can read it without fetch)", async () => {
    await buildRenderer({ root: desktop, outdir: out });
    const file = readFileSync(join(out, FE_MANIFEST_FILE), "utf8");
    const manifest = parseFeManifest(JSON.parse(file));
    expect(manifest.plugins.map((plugin) => plugin.name)).toContain("botling.settings");
    const js = readFileSync(join(out, "renderer.js"), "utf8");
    // The define is a string literal; the bundler prints it as a template literal, or with double or single quotes.
    const forms = [file, JSON.stringify(file), JSON.stringify(file).slice(1, -1), JSON.stringify(file).slice(1, -1).replaceAll('\\"', '"')];
    expect(forms.some((form) => js.includes(form)), "the manifest text is in renderer.js").toBe(true);
    for (const { name, codeHash } of manifest.plugins) {
      expect(js.includes(codeHash), `${name}'s hash`).toBe(true);
    }
  }, 60_000);

  it("does not call fetchFeManifest: the shell's host reads embeddedFeManifest", () => {
    const host = readFileSync(join(desktop, "src/renderer/shell/inpage-host.ts"), "utf8");
    expect(host).toContain("embeddedFeManifest()");
    expect(host.replace(/\/\/.*$/gm, "")).not.toContain("fetchFeManifest");
  });
});
