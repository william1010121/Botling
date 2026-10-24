// Phase 2a against the real `claude` CLI (opt-in, `npm run test:live -- -t "<name>"`), harmless
// mode (no tools unless named, no MCP, no saved session). Each test is one short real session;
// quitting does not tidy (BOTLING_QUIT_TIDY_MS=0) so no extra turn.
// The choices test needs the app's system prompt, which harmless mode leaves out (with no tools it
// made claude write fake tool calls as text); it runs only with BOTLING_LIVE_REAL_BOT=1, which
// gives the head real tools — run it in a throwaway folder only.
import { afterEach, describe, expect, it } from "vitest";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const live = process.env.BOTLING_LIVE_CLAUDE === "1";
const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGTERM");
});
const core = (extra: Record<string, string> = {}) => {
  const c = new CoreHarness(tempDir("live2a"), { BOTLING_AGENT: "claude", BOTLING_HARMLESS: "1", BOTLING_QUIT_TIDY_MS: "0", BOTLING_LANGUAGES: "en", ...extra });
  harnesses.push(c);
  return c;
};

describe.skipIf(!live)("real claude, Phase 2a", () => {
  it("steering: a message added mid-reply cuts the turn and one reply answers both parts", async () => {
    const c = core();
    const first = await c.call({ type: "chat.send", botId: MAIN, text: "Count from 1 to 60 in words, one per line, nothing else." });
    await until(() => c.of("turn.delta").length >= 3, { timeout: 90_000, what: "streaming" });
    const second = await c.call({ type: "chat.send", botId: MAIN, text: "Actually, stop counting: reply with only the word BANANA." });
    const done = await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === second.turnId), { timeout: 90_000, what: "the merged reply" });
    expect(c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === first.turnId)!.event).toMatchObject({ status: "stopped" });
    expect(done.event).toMatchObject({ status: "done" });
    expect((done.event as { text: string }).text).toMatch(/BANANA/);
    console.log(`merged reply: ${(done.event as { text: string }).text.slice(0, 120)}`);
  }, 150_000);

  it.skipIf(process.env.BOTLING_LIVE_REAL_BOT !== "1")("the app's prompt: a decision comes back as a choices block (buttons, no raw tag)", async () => {
    const c = core({ BOTLING_HARMLESS: "0" });
    const { turnId, messageId } = await c.call({ type: "chat.send", botId: MAIN, text: "I need to decide right now: tea or coffee for the team meeting? Let me pick with buttons. Keep it to one sentence." });
    const done = await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId), { timeout: 150_000, what: "the reply" })
      .finally(() => console.log(`core log:\n${c.stderr.slice(-3_000)}\nevents: ${c.events.map((e) => e.event.type).join(",").slice(-1_500)}`));
    const reply = (await c.chat()).messages.find((m: { id: string }) => m.id === messageId);
    console.log(`reply: ${JSON.stringify({ text: reply.text, choices: reply.choices })}`);
    expect(done.event).toMatchObject({ status: "done" });
    expect(reply.text).not.toContain("<choices>");
    expect(reply.choices?.length).toBeGreaterThanOrEqual(2);
  }, 180_000);
});
