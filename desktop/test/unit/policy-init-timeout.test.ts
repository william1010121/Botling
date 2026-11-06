import { describe, expect, it } from "vitest";
import { POLICY_INIT_TIMEOUT_MS } from "../../src/core/agent/head";

// 2026-11-06: under heavy load (swap full, load average 200+) the claude CLI took ~20 s to answer
// `initialize`; the old 10 s limit failed every new worker at startup ("could not register its tool policy").
describe("tool policy initialize timeout", () => {
  it("leaves a slow CLI enough time to answer initialize", () => {
    expect(POLICY_INIT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});
