// @vitest-environment jsdom
// `PLUGIN_OWNED_SLOTS` (shell/feed-slots.ts) is exactly what the in-page built-in plugins the FE build ships provide, no more and
// no less (M7-03a review). Each plugin's own test checks its own slots; this one checks the list as a whole, so a stray entry
// (a slot no built-in provides: `:shell` would stop owning it and the feed's rows for it would be refused) fails here, and a new
// built-in plugin (04b, 05a, 06a, …) is checked without editing this file.
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSlot } from "../../../Web/src/plugin-kernel";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { rendererKernel } from "../../src/renderer/renderer-kernel";
import { PLUGIN_OWNED_SLOTS } from "../../src/renderer/shell/feed-slots";
import { InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { desktop } from "../helpers";

const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const hosts: InPageHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.stop();
  reconcileView(null);
});

describe("PLUGIN_OWNED_SLOTS", () => {
  it("is the union of the slots the shipped in-page plugins provide (each plugin loads, and the lists agree)", async () => {
    const host = new InPageHost({ manifest, log: () => {} });
    hosts.push(host);
    const results = await host.start();
    expect(results.map((result) => result.status)).toEqual(manifest.plugins.map(() => "loaded"));
    const provided = manifest.plugins.flatMap((entry) => rendererKernel.declaration(entry.name)?.provides?.slots ?? []);
    expect(new Set(provided).size, "no slot is provided twice").toBe(provided.length);
    expect(provided.slice().sort()).toEqual(PLUGIN_OWNED_SLOTS.map(canonicalSlot).sort());
  });
});
