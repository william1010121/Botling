// The component editor's model at startup (server.ts): settings.json's `componentEditorModel` is written into the
// library's component-editor.md only when it is a Claude model; any other value (it would go into a YAML line) is
// replaced by the default. The core runs from the built `out/`, so a mutation of server.ts needs a rebuild (L-017).
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

/** Starts a core on a data folder whose settings.json holds `settings`, and returns the editor file the library got. */
async function editorFile(settings: Record<string, unknown>) {
  const dir = tempDir("editor-startup-model");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  const harness = new CoreHarness(dir, { BOTLING_ROUTINE_TICK_MS: "0", BOTLING_COMPONENT_SCAN_MS: "0" });
  harnesses.push(harness);
  await harness.call({ type: "chat.snapshot", botId: MAIN });
  return readFileSync(join(dir, "plugins", "ccb-core", "claude", "agents", "component-editor.md"), "utf8");
}

describe("the component editor's model at startup", () => {
  it.each(["claude-fable-5-2", "claude-opus-5-5[1m]", "haiku"])("a saved Claude model (%s) is the editor's model", async (model) => {
    expect(await editorFile({ componentEditorModel: model })).toContain(`\nmodel: ${model}\n`);
  });

  it.each(["gpt-6-luna", "opus\nx: y", "claude-x\ntools: Bash", 7])("a saved value that is not a Claude model (%j) gives the default and adds no line of its own", async (model) => {
    const text = await editorFile({ componentEditorModel: model });
    expect(text).toContain("\nmodel: sonnet\n");
    expect(text).not.toMatch(/^x: y$/m);
    expect(text).not.toMatch(/^tools: Bash$/m);
  });
});
