// A message to a bot in Idle brings it back to the left column's list (settings.idleBots).
import { afterEach, expect, it } from "vitest";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const c of harnesses.splice(0)) await c.kill(); });

it("sending a message takes the bot out of Idle and leaves the other idle bots alone", async () => {
  const dir = tempDir("idle-wake");
  const c = new CoreHarness(dir, { FAKE_CLAUDE_INPUT: `${dir}/input.log` });
  harnesses.push(c);
  const OTHER = "11111111-2222-4333-8444-555555555555";
  await c.call({ type: "settings.set", change: { key: "idleBots", value: [MAIN, OTHER] } });
  expect((await c.call({ type: "settings.get" })).idleBots).toEqual([MAIN.toUpperCase(), OTHER.toUpperCase()]);
  const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "hello" });
  await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId));
  expect((await c.call({ type: "settings.get" })).idleBots).toEqual([OTHER.toUpperCase()]);
});
