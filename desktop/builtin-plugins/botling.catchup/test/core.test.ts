// Catch-up through the built core and its plugin host running botling.catchup: when you read a chat with more
// unread replies than the threshold, the few that matter stay in view and the rest are folded behind a header that
// reaches the chat as a message decoration. No model is called and nothing is summarized or kept on disk.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../../../test/helpers";
import { CoreHarness, MAIN } from "../../../test/core-harness";

const harnesses: CoreHarness[] = [];
function core(dir: string) {
  const harness = new CoreHarness(dir, { BOTLING_ROUTINE_TICK_MS: "0" });
  harnesses.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

const id = (n: number) => `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`;
function seed(dir: string, roles: string[], unread: number, extra: Record<number, Record<string, unknown>> = {}) {
  const folder = join(dir, "main");
  mkdirSync(folder, { recursive: true });
  const lines = roles.map((role, i) => ({ id: id(i + 1), role, text: `${role} ${i + 1}`, date: 800_000_000 + i, ...extra[i + 1] }));
  writeFileSync(join(folder, "chat.json"), JSON.stringify(lines));
  writeFileSync(join(folder, "bot.json"), JSON.stringify({ unread }));
  return lines;
}
/** The chat's fold as the page gets it: botling.catchup's decorations. */
async function folds(c: CoreHarness): Promise<any[]> {
  return ((await c.chat()).decorations ?? []).filter((d: any) => d.plugin === "botling.catchup");
}
/** The plugin host has loaded botling.catchup (events before that are kept, but calls wait for it). */
const ready = (c: CoreHarness) => until(async () => (await c.call({ type: "plugins.list" })).host.running, { timeout: 20_000 });
const never = async () => { await new Promise((resolve) => setTimeout(resolve, 400)); };

describe("Catch-up", () => {
  it("six unread replies: the newest three stay, the other three fold behind one header; nothing is summarized", async () => {
    const dir = tempDir("catchup-top3");
    seed(dir, ["user", "bot", "bot", "bot", "bot", "bot", "bot"], 6);
    const c = core(dir);
    await ready(c);
    await c.call({ type: "chat.read", botId: MAIN });
    const [fold] = await until(async () => { const list = await folds(c); return list.length ? list : null; });
    expect(fold).toMatchObject({ key: `unread:${id(2)}-${id(4)}`, fold: [id(2), id(3), id(4)], data: { kind: "unread", important: 3, ids: [id(2), id(3), id(4)] } });
    expect(fold.data).not.toHaveProperty("bullets");
    expect(fold.data).not.toHaveProperty("state");
    // The chat itself is untouched: every line is still there.
    expect((await c.chat()).messages).toHaveLength(7);
    // Nothing was cached.
    expect(existsSync(join(dir, "plugin-data", "botling.catchup", "summaries.json"))).toBe(false);
  });

  it("an error stays in view over newer plain replies", async () => {
    const dir = tempDir("catchup-top3-error");
    seed(dir, ["user", "bot", "error", "bot", "bot", "bot", "bot"], 6);
    const c = core(dir);
    await ready(c);
    await c.call({ type: "chat.read", botId: MAIN });
    const [fold] = await until(async () => { const list = await folds(c); return list.length ? list : null; });
    // The error (3) and the newest two replies (6, 7) stay; 2, 4, 5 fold.
    expect(fold.fold).toEqual([id(2), id(4), id(5)]);
    expect(fold.data.important).toBe(3);
  });

  it("no more unread replies than the threshold: nothing folds", async () => {
    const dir = tempDir("catchup-top3-few");
    seed(dir, ["user", "bot", "bot", "bot"], 3);
    const c = core(dir);
    await ready(c);
    await c.call({ type: "chat.read", botId: MAIN });
    await never();
    expect(await folds(c)).toEqual([]);
  });

  it("the old switch in settings.json is taken over: off means nothing folds", async () => {
    const dir = tempDir("catchup-top3-off");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ catchUpEnabledChoice: false, catchUpModelChoice: "opus", summaryPromptChoice: "Be terse." }));
    seed(dir, ["user", "bot", "bot", "bot", "bot", "bot", "bot"], 6);
    const c = core(dir);
    await ready(c);
    await c.call({ type: "chat.read", botId: MAIN });
    await never();
    expect(await folds(c)).toEqual([]);
  });
});
