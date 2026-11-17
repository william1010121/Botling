// The quit-time tidy has a cap: an install or restart is not held by a slow tidy (measured quits with no limit: 7 s to 52 s).
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { coreProcessOptions, QUIT_TIDY_MS } from "../../src/core/core-process";

const options = (env: Record<string, string>) => coreProcessOptions({
  env, dataDir: "/tmp/quit-tidy-cap", outDir: join("/tmp/quit-tidy-cap", "out"), emit: () => {}, log: () => {}, node: null, sealer: null, app: null,
});

describe("quitTidyMs of a core process", () => {
  it("is capped by default, at 10 s", () => {
    expect(QUIT_TIDY_MS).toBe(10_000);
    expect(options({}).quitTidyMs).toBe(10_000);
  });
  it("BOTLING_QUIT_TIDY_MS changes it, 0 included; a value that is not a finite number keeps the cap", () => {
    expect(options({ BOTLING_QUIT_TIDY_MS: "0" }).quitTidyMs).toBe(0);
    expect(options({ BOTLING_QUIT_TIDY_MS: "2500" }).quitTidyMs).toBe(2_500);
    expect(options({ BOTLING_QUIT_TIDY_MS: "Infinity" }).quitTidyMs).toBe(10_000);
  });
});
