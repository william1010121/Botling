// @vitest-environment jsdom
// The FE build manifest must load and run under jsdom (M7-10c regression): fe-shell-manifest.mjs used to `import { buildSync } from "esbuild"`
// at the top, and esbuild throws while loading under jsdom (`new TextEncoder().encode("") instanceof Uint8Array` is false there), so every
// jsdom test file that imported fe-build-manifest.mjs (e.g. a plugin's test reading the manifest) failed before its first test.
// Now esbuild runs in a child node process (fe-shell-manifest.mjs `shellInputs`): importing has no esbuild side effect, calling works here too.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { shellInputs } from "../../fe-shell-manifest.mjs";

const desktop = resolve(__dirname, "../..");

describe("fe-build-manifest under jsdom", () => {
  it("imports without loading esbuild, and feBuildManifestFile reads the real manifest", () => {
    expect(typeof feBuildManifestFile).toBe("function");
    const manifest = JSON.parse(feBuildManifestFile(desktop).toString("utf8"));
    expect(manifest.version).toBe(1);
    expect(manifest.shell.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(manifest.plugins)).toBe(true);
  }, 60_000);

  it("shellInputs lists the shell's files (no plugin sources) from inside jsdom", () => {
    const files = shellInputs(resolve(desktop, ".."));
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain("desktop/web-v3/shell/main.tsx");
    expect(files.some((path) => path.startsWith("desktop/src/renderer/plugins/"))).toBe(false);
  }, 60_000);
});
