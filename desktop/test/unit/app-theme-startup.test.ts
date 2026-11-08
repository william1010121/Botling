// After a restart the saved Settings → Appearance → App look (and the saved shortcuts and report look) must be
// applied. main read them with `settings.get` before it had started the core, so the CoreClient answered
// core_unavailable, the read was dropped and the app always came back dark, whatever was saved.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CoreClient } from "../../src/main/core-client";
import { desktop } from "../helpers";

vi.mock("electron", () => ({ MessageChannelMain: class {}, utilityProcess: { fork: () => { throw new Error("not in this test"); } } }));

it("a core that is not started yet cannot answer settings.get", async () => {
  const core = new CoreClient({ script: "/nowhere/core/main.cjs", env: {}, onEvent: () => {}, audit: () => {} });
  await expect(core.call({ type: "settings.get" })).rejects.toThrow(/core_unavailable/);
});

it("main reads the saved settings (app look, report look, shortcuts) only after it has started the core", () => {
  const main = readFileSync(join(desktop, "src/main/main.ts"), "utf8");
  const ready = main.slice(main.indexOf("app.whenReady().then("));
  const start = ready.indexOf("core.start();");
  expect(start).toBeGreaterThan(-1);
  // Every settings.get main makes while starting up comes after core.start().
  const reads = [...ready.matchAll(/settings\.get"|applySavedSettings\(\)/g)].map((match) => match.index!);
  expect(reads.length).toBeGreaterThan(0);
  for (const at of reads) expect(at).toBeGreaterThan(start);
  // The read applies the saved look.
  const body = main.slice(main.indexOf("function applySavedSettings"), main.indexOf("function applySavedSettings") + 600);
  expect(body).toContain('type: "settings.get"');
  expect(body).toContain("applyAppTheme(");
});
