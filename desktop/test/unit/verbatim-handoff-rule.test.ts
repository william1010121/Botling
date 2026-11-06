// Math, 2026-11-06: asked for a verbatim .md of its three rounds with Claude, the Antigravity head briefed its worker
// with its own English summary and no source, and the worker rewrote it. Every engine's head is told to hand over the
// source (or its exact paths) for a verbatim request, and to have the worker quote it.
import { expect, it, vi } from "vitest";
vi.mock("../../src/core/agent/agy-capabilities", async (original) => ({ ...(await original<any>()), agyWorkerRuntimeEnabled: () => true }));
import { botPrompts, desktopPrompts, VERBATIM_HANDOFF_RULE } from "../../src/core/prompts";

it("is one sentence that names the source, its paths and quoting", () => {
  expect(VERBATIM_HANDOFF_RULE).toMatch(/verbatim, a transcript or the original text/);
  expect(VERBATIM_HANDOFF_RULE).toMatch(/exact file paths/);
  expect(VERBATIM_HANDOFF_RULE).toMatch(/never only your own summary/);
  expect(VERBATIM_HANDOFF_RULE).toMatch(/quote from it, not rewrite it/);
});

for (const engine of ["claude", "codex", "agy"] as const) it(`a ${engine} head is told it`, () => {
  const profile = { name: "Math", role: "bot" as const, folder: "/Users/x/docs/Math", memoryPath: ".bot/memory.md", job: null };
  const system = desktopPrompts(botPrompts({ profile, engine }), profile, engine).system;
  expect(system).toContain(VERBATIM_HANDOFF_RULE);
});
