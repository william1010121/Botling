// agy's real context window: the ACP server's usage_update { used, size } carries the model's full window as `size`.
// We keep the latest positive `size` per conversation (never `used`) and hand it out as workspace.agyUsage(...).window.
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { conversation, generation, usage } from "./agy-db-fixture";
import { AgyAcpProtocol } from "../../src/core/agent/agy-acp";
import { agyUsageInProfiles } from "../../src/core/agy-usage-db";
import { agyWindowOf, forgetAgyWindows, recordAgyWindow } from "../../src/core/agy-window";

const clients: AgyAcpProtocol[] = [];
afterEach(() => { clients.splice(0).forEach(c => c.close()); forgetAgyWindows(); });
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

async function started() {
  const frames: any[] = [], items: any[] = [], errors: Error[] = [];
  const client = new AgyAcpProtocol({ command: "never-launched", cwd: "/owned", sessionId: "old", resume: false, bypassPermissions: false, worker: false }, m => frames.push(m), i => items.push(i), e => errors.push(e), { localToolEvents: false });
  clients.push(client);
  const reply = (result: any) => client.receive({ jsonrpc: "2.0", id: frames.findLast(f => f.method && f.id).id, result });
  const done = client.send("task", "u");
  reply({ protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "1.4.3" }, agentCapabilities: { loadSession: true } });
  await tick(); reply({ sessionId: "agy-win" }); await tick();
  reply({ configOptions: [{ id: "mode", currentValue: "default" }] }); await tick();
  const update = (u: any, sessionId = "agy-win") => client.receive({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
  return { client, update, errors, done };
}

describe("agy window from ACP usage_update", () => {
  it("keeps the latest positive size per conversation; none before an event", async () => {
    const h = await started();
    expect(agyWindowOf("agy-win")).toBeNull();
    h.update({ sessionUpdate: "usage_update", used: 38_300, size: 1_048_576 });
    expect(agyWindowOf("agy-win")).toMatchObject({ size: 1_048_576 });
    expect(typeof agyWindowOf("agy-win")!.at).toBe("number");
    h.update({ sessionUpdate: "usage_update", used: 5, size: 2_000_000 });
    expect(agyWindowOf("agy-win")!.size).toBe(2_000_000);
    expect(h.errors).toEqual([]);
  });

  it("ignores size 0, missing, negative or non-numeric, and never stores used", async () => {
    const h = await started();
    for (const bad of [{ used: 9, size: 0 }, { used: 9 }, { used: 9, size: -1 }, { used: 9, size: "1048576" }, { used: 9, size: Number.NaN }]) h.update({ sessionUpdate: "usage_update", ...bad });
    expect(agyWindowOf("agy-win")).toBeNull();
    h.update({ sessionUpdate: "usage_update", used: 9, size: 1_048_576 });
    h.update({ sessionUpdate: "usage_update", used: 9, size: 0 });
    expect(agyWindowOf("agy-win")!.size).toBe(1_048_576);
    expect(JSON.stringify(agyWindowOf("agy-win"))).not.toContain("used");
    expect(h.errors).toEqual([]);
  });

  it("an update for another conversation is not recorded as ours", async () => {
    const h = await started();
    h.update({ sessionUpdate: "usage_update", used: 1, size: 1_048_576 }, "someone-else");
    expect(agyWindowOf("agy-win")).toBeNull();
    expect(agyWindowOf("someone-else")).toBeNull();
  });
});

describe("workspace.agyUsage window field", () => {
  it("window is the recorded size, null with no event", () => {
    const dir = tempDir("agy-window");
    const c = conversation(join(dir, "agy-acp", "profile-1"), "agy-s1");
    c.add(generation({ usage: usage({ input: 40, output: 9, cacheRead: 100 }) }));
    c.db.close();
    expect(agyUsageInProfiles(dir, "agy-s1")).toMatchObject({ sessionId: "agy-s1", window: null });
    recordAgyWindow("agy-s1", 1_048_576);
    expect(agyUsageInProfiles(dir, "agy-s1")).toMatchObject({ sessionId: "agy-s1", window: 1_048_576 });
    recordAgyWindow("agy-s1", 0);
    expect(agyUsageInProfiles(dir, "agy-s1")!.window).toBe(1_048_576);
    expect(agyUsageInProfiles(dir, "none")).toBeNull();
  });
});
