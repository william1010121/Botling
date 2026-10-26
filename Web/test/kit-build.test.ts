// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kitV1 } from "../kit/generated/kit-v1";
import { buildKit } from "../kit/build.mjs";

// The kit's text is built from Web/kit/src and committed (generated/), so the app builds need no extra
// step; this keeps the two from drifting apart. (Node environment: esbuild does not run in jsdom.)
describe("the kit's build", () => {
  it("is fresh: generated/ is what building src/ gives now (run node Web/kit/build.mjs)", async () => {
    const built = await buildKit({ write: false });
    expect(built.fresh).toBe(true);
    expect(built.js).toBe(readFileSync(join(__dirname, "../kit/generated/kit.v1.js"), "utf8"));
  });

  it("is small, has its licences and nothing that would end the inline script", () => {
    expect(kitV1.length).toBeLessThan(50_000);
    expect(kitV1).toMatch(/Preact.*@license MIT/);
    expect(kitV1).toMatch(/htm.*@license Apache-2\.0/);
    expect(kitV1).not.toMatch(/<\/script|<!--/i);
  });
});
