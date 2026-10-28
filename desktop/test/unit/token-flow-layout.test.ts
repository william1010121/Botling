import { expect, it } from "vitest";
import { addPositions, fitCamera, layoutFlow, NODE_WIDTH, zoomCamera } from "../../src/renderer/token-flow-layout";
import { DelegationRowView } from "../../src/contract";
import { SubagentBook, readSubagent } from "../../src/core/subagents";

it("uses ELK for a directed three-level layout and fits negative manual coordinates", async () => {
  const points = await layoutFlow(["root", "parent", "child"], [{ source: "root", target: "parent" }, { source: "parent", target: "child" }]);
  expect(points.parent.x).toBeGreaterThan(points.root.x + NODE_WIDTH);
  expect(points.child.x).toBeGreaterThan(points.parent.x + NODE_WIDTH);
  const camera = fitCamera({ left: { x: -500, y: -300 }, right: { x: 3000, y: 900 } }, 390, 420);
  expect(camera.x - 500 * camera.scale).toBeGreaterThanOrEqual(0);
  expect(camera.x + (3000 + NODE_WIDTH) * camera.scale).toBeLessThanOrEqual(390);
  const zoomed = zoomCamera(camera, camera.scale * 2, { x: 150, y: 100 });
  expect((150 - zoomed.x) / zoomed.scale).toBeCloseTo((150 - camera.x) / camera.scale);
  expect(addPositions({ stale: { x: 1, y: 1 }, root: points.root }, ["root", "new"]).root).toEqual(points.root);
  expect(addPositions({ stale: { x: 1, y: 1 } }, ["root"])).not.toHaveProperty("stale");
});

it("projects bounded nested identities without prompts, results or inferred parents", () => {
  const records = Array.from({ length: 502 }, (_, index) => readSubagent({ id: `w${index}`, parentID: index ? `w${index - 1}` : undefined, description: "Worker", status: "running", prompt: "PRIVATE", result: "PRIVATE", steps: [], startedAt: 0 })!);
  const rows = new SubagentBook(records).delegationRows("codex");
  expect(rows).toHaveLength(500);
  expect(DelegationRowView.parse(rows[0])).toMatchObject({ id: "w2", parentId: "w1", outputTokens: null });
  expect(rows.at(-1)?.parentId).toBe("w500");
  expect(JSON.stringify(rows)).not.toContain("PRIVATE");
});

it("publishes nested worker counters through the existing event and read-only history without sidebar payload expansion", async () => {
  const { Bot } = await import("../../src/core/bot");
  const { ProcessLedger } = await import("../../src/core/process/ledger");
  const { mainProfile } = await import("../../src/core/store/workspace");
  const { tempDir } = await import("../helpers");
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const folder = tempDir("token-flow-nested"); const profile = mainProfile(folder);
  mkdirSync(profile.storeDir, { recursive: true });
  const events: import("../../src/contract").Event[] = [];
  const bot = new Bot({ profile, engine: "codex", deferStartup: true, welcome: false,
    ledger: new ProcessLedger(join(folder, "ledger.json")), headConfig() { throw new Error("No CLI"); }, prompts() { throw new Error("No turn"); },
    emit: event => events.push(event), log() {}, approvalTimeoutMs: 100, idleMs: 100, interruptGraceMs: 100 });
  try {
    for (const [id, parentID] of [["parent", undefined], ["child", "parent"]]) bot.subagents.list.push(readSubagent({ id, parentID, description: id, prompt: "private", status: "running", startedAt: 0, steps: [] })!);
    const send = (tokens: number) => (bot as unknown as { onSubagentItem(item: import("../../src/core/agent/codex").CodexItem): void }).onSubagentItem({ kind: "subagentOutput", id: "child", counter: "thread", tokens });
    send(10); events.length = 0; send(20);
    const event = events.find(value => value.type === "subagent.updated");
    expect(event?.type).toBe("subagent.updated");
    if (event?.type === "subagent.updated") expect(event.subagent.outputTokens).toBe(20);
    const { tokenFlowHistory } = await import("../../src/core/token-flow-history");
    expect((await tokenFlowHistory(bot)).rows.find(row => row.id === "child")).toMatchObject({ parentId: "parent", outputTokens: 20 });
    expect(bot.view().subagentRows.map(row => row.id)).toEqual(["parent"]);
  } finally { await bot.shutdown({ tidy: false }); }
});
