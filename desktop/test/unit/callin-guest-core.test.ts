// Botling 3 M5-02b: `Core.serverCallIn` runs the guest's turn of a call-in from another server in the guest's own session
// (the 2.x call-in turn, `Bot.groupTurn`), keeps the reply in the guest's own chat (`Bot.keepCallIn`), and ends the wait
// and the turn when its signal aborts (`callin.cancel`, D51). Over a real Core and the fake claude CLI (no window).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Outbound } from "../../src/contract";
import { Core } from "../../src/core/server";
import { coreProcessOptions } from "../../src/core/core-process";
import type { Bot } from "../../src/core/bot";
import { saveProjectRow } from "../../src/core/projects";
import { guestPrompt } from "../../src/server/callin";
import { fakeCli, tempDir } from "../helpers";

const GUEST = "6AC64E3A-C7D7-4000-8000-000000000011";
const cores: Core[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const core of cores.splice(0)) await core.shutdown().catch(() => {});
});

function fixture(env: Record<string, string> = {}) {
  const dir = tempDir("callin-guest-core");
  const folder = tempDir("callin-guest-core-project");
  mkdirSync(join(folder, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: GUEST, name: "tester", folder, avatar: "triangle" });
  const base = coreProcessOptions({
    env: {
      BOTLING_AGENT: "fake", BOTLING_FAKE_CLI: fakeCli, BOTLING_COMPONENT_SCAN_MS: "0", BOTLING_WAITING_SCAN_MS: "0",
      BOTLING_ROUTINE_TICK_MS: "0", BOTLING_WATCH_MS: "0", BOTLING_QUIT_TIDY_MS: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env,
    },
    dataDir: dir, outDir: `${dir}/unused-out`, emit: (_message: Outbound) => {}, log: () => {}, node: null, sealer: null, app: null,
  });
  const core = new Core({ ...base, plugins: null });
  cores.push(core);
  const bot: Bot = (core as unknown as { bots: Map<string, Bot> }).bots.get(GUEST)!;
  return { core, bot };
}

const prompt = guestPrompt({
  hostName: "build", guestName: "tester", by: "user", asked: "@tester /guestsay hello from the other machine",
  transcript: "User: hi\n\"build\": hello\nUser (newest): @tester /guestsay hello from the other machine",
});
const call = (over: Partial<Parameters<Core["serverCallIn"]>[2]> = {}): Parameters<Core["serverCallIn"]>[2] => ({
  host: { botId: "6A0B0000-0000-4000-8000-000000000003", name: "build" }, asked: "@tester /guestsay hello from the other machine", by: "user",
  note: "Called into build's chat with @: @tester /guestsay hello from the other machine", busyWaitMs: 200, answerMs: 20_000, onBegin: () => {}, ...over,
});

describe("M5-02b: Core.serverCallIn", () => {
  it("answers in the guest's own session and keeps the notice and the reply in the guest's own chat", async () => {
    const { core, bot } = fixture();
    let began = 0;
    const answer = await core.serverCallIn(GUEST, prompt, call({ onBegin: () => { began += 1; } }));
    expect(answer).toMatchObject({ kind: "reply", text: "hello from the other machine" });
    expect(began).toBe(1);
    const lines = bot.lines();
    expect(lines.some((line) => line.role === "notice" && line.text === "Called into build's chat with @: @tester /guestsay hello from the other machine")).toBe(true);
    expect(lines.some((line) => line.role === "bot" && line.text === "hello from the other machine")).toBe(true);
    // A bot that is not here: failed, nothing thrown.
    expect(await core.serverCallIn("NO-SUCH-BOT", prompt, call())).toEqual({ kind: "failed", why: "It is not running." });
  });

  it("a signal that aborts while the guest runs ends the turn at once: failed \"cancelled\", the guest is free again", async () => {
    vi.stubEnv("FAKE_CLAUDE_GUEST_MS", "8000");
    const { core, bot } = fixture({ FAKE_CLAUDE_GUEST_MS: "8000" });
    const controller = new AbortController();
    const started = Date.now();
    const pending = core.serverCallIn(GUEST, prompt, call({ answerMs: 60_000, signal: controller.signal, onBegin: () => setTimeout(() => controller.abort(), 150) }));
    const answer = await pending;
    expect(answer).toEqual({ kind: "failed", why: "cancelled" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(bot.takesGuest).toBe(true);
    // Nothing of a cancelled call-in is kept in the guest's chat.
    expect(bot.lines().some((line) => line.role === "notice" && line.text.startsWith("Called into"))).toBe(false);
  }, 30_000);

  it("a signal that aborts while a busy guest is waited for ends the wait; one aborted before the start never begins", async () => {
    const { core, bot } = fixture();
    (bot as unknown as { guestTurn: boolean }).guestTurn = true; // busy with another guest turn
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const waited = await core.serverCallIn(GUEST, prompt, call({ busyWaitMs: 20_000, signal: controller.signal }));
    expect(waited).toEqual({ kind: "failed", why: "cancelled" });
    // Without a signal the same wait ends in `busy`, as in 2.x.
    expect(await core.serverCallIn(GUEST, prompt, call({ busyWaitMs: 100 }))).toEqual({ kind: "busy" });
    (bot as unknown as { guestTurn: boolean }).guestTurn = false;
    let began = 0;
    const before = new AbortController();
    before.abort();
    expect(await core.serverCallIn(GUEST, prompt, call({ signal: before.signal, onBegin: () => { began += 1; } }))).toEqual({ kind: "failed", why: "cancelled" });
    expect(began).toBe(0);
  }, 30_000);
});
