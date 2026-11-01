// The blank-bubble rule through the built core and the fake CLI (shared-core spec 2.7, D5): your message answered with
// nothing visible gets no bubble (it used to get an empty one); `turn.finished` still goes out, with no text. Words,
// and steps, still show.
import { afterEach, describe, expect, it } from "vitest";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

async function turn(c: CoreHarness, text: string) {
  const { turnId, messageId } = await c.call({ type: "chat.send", botId: MAIN, text });
  const finished = await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId), { what: `the end of "${text}"` });
  return { messageId, event: finished.event as { status: string; text: string } };
}

describe("a head turn with nothing to show", () => {
  it("your message answered with only <no-reply/>: no bubble, saved or drawn; the turn still ends done", async () => {
    const c = new CoreHarness(tempDir("blank"));
    harnesses.push(c);
    const { messageId, event } = await turn(c, "/say <no-reply/>");
    expect(event).toMatchObject({ status: "done", text: "" });
    const chat = await c.chat();
    expect(chat.messages.some((m: { id: string }) => m.id === messageId)).toBe(false);
    expect(chat.messages.filter((m: { role: string }) => m.role === "bot")).toEqual([]);
    // The next message is answered as usual.
    const next = await turn(c, "/say Still here.");
    expect(next.event).toMatchObject({ status: "done", text: "Still here." });
    expect((await c.chat()).messages.find((m: { id: string }) => m.id === next.messageId)).toMatchObject({ role: "bot", text: "Still here." });
  });
});
