// @vitest-environment node
import { build } from "esbuild";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/** Runs a guard script against a stand-in window; returns its listeners. */
function listen(source: string) {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const fake = { addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] ??= []).push(fn) };
  new Function("window", source)(fake);
  return listeners;
}

describe("the input-method guard as built", () => {
  it("is self-contained, so the minified chat.js still hands a working copy to every component frame", async () => {
    // Bundled and minified as build.mjs does chat.js, then the frame's copy taken out of it.
    const result = await build({
      stdin: { contents: `import { imeGuardScript } from "./ime"; globalThis.script = imeGuardScript;`, resolveDir: join(__dirname, "../src"), loader: "ts" },
      bundle: true, format: "iife", target: "safari17", minify: true, write: false,
    });
    const holder: { script?: string } = {};
    new Function("globalThis", result.outputFiles[0].text)(holder);
    expect(holder.script).toMatch(/^\(function/);
    const listeners = listen(holder.script!);
    expect(Object.keys(listeners).sort()).toEqual(["blur", "compositionend", "compositionstart", "keydown", "keypress"]);
    const stopped = vi.fn();
    listeners.keydown[0]({ type: "keydown", key: "Enter", keyCode: 229, isComposing: false, stopImmediatePropagation: stopped, preventDefault() {} });
    expect(stopped).toHaveBeenCalled();
    const passed = vi.fn();
    listeners.keydown[0]({ type: "keydown", key: "a", keyCode: 65, isComposing: false, stopImmediatePropagation: passed, preventDefault() {} });
    expect(passed).not.toHaveBeenCalled();
  });
});
