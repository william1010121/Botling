import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { specTrace } from "../../desktop/src/core/spec-trace";

const dirs: string[] = [];
afterEach(() => {
  delete process.env.BOTLING_SPEC_TRACE;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("writes one JSON line per traced action only while BOTLING_SPEC_TRACE names a folder", () => {
  specTrace("restart", "Begin", { phase: "preparing" });
  const dir = mkdtempSync(join(tmpdir(), "spec-trace-"));
  dirs.push(dir);
  process.env.BOTLING_SPEC_TRACE = dir;
  specTrace("restart", "Begin", { phase: "preparing" });
  specTrace("restart", "Ready", { phase: "ready" });
  const lines = readFileSync(join(dir, "restart.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.map((line) => line.action)).toEqual(["Begin", "Ready"]);
  expect(lines[1].state).toEqual({ phase: "ready" });
});
