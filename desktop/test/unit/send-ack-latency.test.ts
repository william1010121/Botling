// The composer's "Sending…" clears when chat.send answers. That answer is the local accept: the
// user's line is on the chat and saved. It must not wait for starting the agent's turn, which does
// synchronous slow work (ps for the process ledger, locks, fsyncs) and so took seconds on a busy Mac.
import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) await h.kill("SIGKILL"); });

/** A `ps` that is slow (a loaded machine) and otherwise the real one. */
function slowPs(dir: string, seconds: number): string {
  const bin = join(dir, "..", `slow-ps-${seconds}`);
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "ps");
  writeFileSync(script, `#!/bin/sh\nsleep ${seconds}\nexec /bin/ps "$@"\n`);
  chmodSync(script, 0o755);
  return bin;
}

it("chat.send answers once the user's line is saved, not after the agent's turn has been started", async () => {
  const dir = tempDir("send-ack");
  const bin = slowPs(dir, 0.8);
  const c = new CoreHarness(dir, { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_CLAUDE_INPUT: join(dir, "input.log") });
  harnesses.push(c);
  await c.chat();
  const started = Date.now();
  const id = c.send({ type: "chat.send", botId: MAIN, text: "hello" });
  const response = await until(() => c.responses.get(id), { what: "the answer to chat.send", timeout: 20_000 });
  const ack = Date.now() - started;
  expect(response.ok).toBe(true);
  // The line was added (and saved) before the answer; the answer does not wait on the slow ps.
  expect(c.of("message.added").some((e) => (e.event as { message: { role: string } }).message.role === "user")).toBe(true);
  expect(ack).toBeLessThan(500);
  // The turn still starts and finishes as before.
  const { turnId } = response.result as { turnId: string };
  await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId), { what: "the turn to finish", timeout: 30_000 });
});
