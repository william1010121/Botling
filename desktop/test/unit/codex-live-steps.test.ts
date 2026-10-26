// A Codex turn still without words: its steps reach the typing bubble live, not only at turn end
// (1.x `ChatPayload.liveSteps`). Guards the path core → chat.snapshot → renderer `chatState`.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoreHarness, MAIN } from "../core-harness";
import { tempDir, until } from "../helpers";
import { chatState } from "../../src/renderer/payload";
import type { BotView } from "../../src/contract";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const core of harnesses.splice(0)) await core.kill("SIGKILL"); });
const bot: BotView = { id: MAIN, name: "Main", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: true, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["codex"], job: null, subagentRows: [] };

describe("Codex live steps", () => {
  it.each([false, true])("show under the typing dots while the reply has no words (switched first: %s)", async (switched) => {
    const dir = tempDir("codex-live-steps");
    if (!switched) {
      mkdirSync(join(dir, "main"), { recursive: true });
      writeFileSync(join(dir, "main/bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"], answerWith: "codex" } }));
    }
    const core = new CoreHarness(dir); harnesses.push(core);
    if (switched) await core.call({ type: "heads.set", botId: MAIN, engines: ["codex"] });
    const sent = await core.call({ type: "chat.send", botId: MAIN, text: "/slow" });
    await until(() => core.of("turn.steps").some((entry: any) => entry.event.turnId === sent.turnId && entry.event.steps.length >= 2));
    const chat = await core.chat();
    expect(chat.running).toMatchObject({ turnId: sent.turnId });
    const { state } = chatState(bot, chat);
    expect(state.working).toBe(true);
    expect((state.live ?? []).map((step) => step.title).slice(0, 2)).toEqual(["still working 0", "still working 1"]);
  });
});
