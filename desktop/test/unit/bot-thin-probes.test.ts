// M7-S60 review follow-up (taken in M7-S60b): the delayed `workers.redeliver()` of `BotWorkers.restoreAtStart` must not run
// once the bot is shutting down. Mutant: drop the `!this.shuttingDown` check in that timer; `bot-thin.test.ts` passed 15/15.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bot } from "../../src/core/bot";
import { BotWorkers } from "../../src/core/bot/workers";
import { mainProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { tempDir } from "../helpers";

const bots: Bot[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const b of bots.splice(0)) await b.shutdown({ tidy: false }).catch(() => {});
});

function make(files: Record<string, string>) {
  const folder = tempDir("bot-thin-probes"), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: "claude", model: "m", heads: { engines: ["claude"], answerWith: "claude" } }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(profile.storeDir, name), text);
  const b = new Bot({ profile, deferStartup: true, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    prompts: (e, heads) => botPrompts({ profile, engine: e, heads }),
    emit() {}, log() {}, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: 10 });
  bots.push(b);
  return b;
}

describe("BotWorkers.restoreAtStart: the report is handed over again only while the bot is alive", () => {
  it("a bot shut down before the timer fires does not redeliver", async () => {
    const calls: string[] = [];
    vi.spyOn(BotWorkers.prototype, "ensureClaudeWorkers").mockImplementation((() => ({ redeliver: () => calls.push("redeliver") })) as any);
    const b = make({ "worker-ledger.json": "[]" });
    await b.shutdown({ tidy: false });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual([]);
  });

  it("the same bot, left running, does redeliver (so the case above is the guard, not a missing timer)", async () => {
    const calls: string[] = [];
    vi.spyOn(BotWorkers.prototype, "ensureClaudeWorkers").mockImplementation((() => ({ redeliver: () => calls.push("redeliver") })) as any);
    make({ "worker-ledger.json": "[]" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual(["redeliver"]);
  });
});
