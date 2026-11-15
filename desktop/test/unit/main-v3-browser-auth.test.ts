// Botling 3's browser pane signs in under the same rules as 2.x (2026-11-15): the v3 window runs the 2.x main's
// browser-host.ts, so its pane session gets plain Chrome's user agent, Chrome's client hints and the sign-in popup rule
// from the shared browser-auth.ts / browser-hints.ts. The v3 build swaps some 2.x imports (build.mjs plugins); these two
// must never be among them, or the v3 pane would sign in differently from 2.x.
import { describe, expect, it } from "vitest";

describe("the v3 browser pane shares 2.x's sign-in rules", () => {
  it("the v3 main bundle resolves browser-host.ts's browser-auth and browser-hints to the shared modules", async () => {
    const { buildMainV3 } = await import("../../build.mjs" as string) as { buildMainV3: (options: { write: boolean; metafile: boolean }) => Promise<import("esbuild").BuildResult> };
    const meta = (await buildMainV3({ write: false, metafile: true })).metafile!;
    const host = meta.inputs["src/main/browser-host.ts"];
    expect(host, "the v3 bundle includes the 2.x browser host").toBeDefined();
    const resolved = (original: string) => host!.imports.filter((item) => item.original === original).map((item) => item.path);
    expect(resolved("../browser-auth")).toEqual(["src/browser-auth.ts"]);
    expect(resolved("../browser-hints")).toEqual(["src/browser-hints.ts"]);
  }, 60_000);
});
