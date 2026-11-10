// app_routines for every engine (2026-11-11, the user: "開成一個 tool 給他"): Claude's and Antigravity's coordinators get
// the same tool Codex has, with the same words and schema, served by the same store (`appRoutinesCall`). Workers never get it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appTools, workerAppTools } from "../../src/core/app-tools/registry";
import { appRoutinesCall } from "../../src/core/routines";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "botling-app-routines-")); dirs.push(dir); return dir; };

describe("app_routines in the registry", () => {
  it("is one tool for Claude, Antigravity and Codex coordinators, byte for byte", () => {
    const of = (provider: "claude" | "agy" | "codex") => appTools(provider).find((tool) => tool.name === "app_routines");
    expect(of("codex")).toBeDefined();
    expect(of("claude")).toEqual(of("codex"));
    expect(of("agy")).toEqual(of("codex"));
    expect((of("claude")!.inputSchema.properties as Record<string, { enum?: string[] }>).kind.enum).toEqual(["once", "recurring", "watch"]);
  });
  it("is never a worker's tool", () => {
    for (const provider of ["claude", "agy", "codex"] as const) expect(workerAppTools(provider).map((tool) => tool.name)).not.toContain("app_routines");
  });
});

describe("appRoutinesCall", () => {
  it("creates, lists and cancels through the bot's store, and is idempotent by request_id", () => {
    const dir = temp(), file = join(dir, "scheduled-routines.json");
    writeFileSync(join(dir, "routines.cron"), "0 9 * * * Morning: say hi\n");
    const create = { operation: "create", kind: "recurring", cron: "0 8 * * *", timezone: "UTC", task: "News: read the news", request_id: "r1" };
    const first = appRoutinesCall(file, create), again = appRoutinesCall(file, create);
    expect(first.success).toBe(true);
    const id = (first.payload as { id: string }).id;
    expect((again.payload as { id: string }).id).toBe(id);
    const listed = appRoutinesCall(file, { operation: "list" }).payload as { routines: { id: string; kind: string }[] };
    expect(listed.routines.map((routine) => routine.kind)).toEqual(["recurring", "legacy_recurring"]);
    expect(appRoutinesCall(file, { operation: "cancel", id }).success).toBe(true);
  });
  it("gives the store's words as an error, and says so when there is no store", () => {
    const file = join(temp(), "scheduled-routines.json");
    expect(appRoutinesCall(file, { operation: "create", kind: "once", task: "x", request_id: "r" })).toMatchObject({ success: false, payload: { error: expect.any(String) } });
    expect(appRoutinesCall(null, { operation: "list" })).toEqual({ success: false, payload: { error: expect.stringContaining("Routine storage is unavailable for this session") } });
  });
});
