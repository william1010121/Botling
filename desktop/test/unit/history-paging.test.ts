// A chat snapshot carries the newest page of the chat (about 1 MiB); older lines come with `chat.history`.
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { tempDir } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { MIN_PAGE_LINES, PAGE_BYTES, pageBack } from "../../src/core/history-page";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) if (h.child.exitCode === null && h.child.signalCode === null) await h.kill("SIGKILL"); });

const lineId = (n: number) => `A0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
/** `count` lines of `size` characters each, oldest first. */
function chat(count: number, size: number) {
  return Array.from({ length: count }, (_, n) => ({
    id: lineId(n), role: n % 2 ? "bot" : "user", text: `#${n} ` + "x".repeat(size), date: 8e8 + n, ...(n % 2 ? { state: "done" } : {}),
  }));
}
async function open(count: number, size: number) {
  const dir = tempDir("history");
  mkdirSync(join(dir, "main"), { recursive: true });
  writeFileSync(join(dir, "main", "chat.json"), JSON.stringify(chat(count, size)));
  const core = new CoreHarness(dir);
  harnesses.push(core);
  return core;
}

describe("pageBack", () => {
  const view = (n: number) => ({ n, pad: "y".repeat(1000) });
  const records = Array.from({ length: 100 }, (_, n) => n);

  it("takes the newest lines that fit, oldest first, and says where it started", () => {
    const page = pageBack(records, 100, view, 10_000);
    expect(page.views.map((v) => v.n)).toEqual(Array.from({ length: page.views.length }, (_, i) => 100 - page.views.length + i));
    expect(page.start).toBe(100 - page.views.length);
    expect(page.views.length).toBeGreaterThanOrEqual(8);
    expect(page.views.length).toBeLessThanOrEqual(10);
  });
  it("is the whole chat when it fits, and ends before `end`", () => {
    expect(pageBack(records, 5, view, 1 << 20)).toMatchObject({ start: 0, views: [0, 1, 2, 3, 4].map((n) => expect.objectContaining({ n })) });
    expect(pageBack(records, 0, view).views).toEqual([]);
  });
  it("always keeps the newest few lines, however big", () => {
    const page = pageBack(records, 100, view, 1);
    expect(page.views).toHaveLength(MIN_PAGE_LINES);
    expect(page.start).toBe(100 - MIN_PAGE_LINES);
  });
});

describe("chat.history", () => {
  it("sends the whole chat, with no history marker, when it is small", async () => {
    const core = await open(40, 200);
    const state = await core.chat();
    expect(state.messages).toHaveLength(40);
    expect(state.history).toBeUndefined();
  });

  it("sends only the newest page of a big chat", async () => {
    const core = await open(200, 40_000); // 8 MB
    const state = await core.chat();
    expect(state.history).toEqual({ hasMore: true, older: 200 - state.messages.length });
    expect(state.messages.length).toBeLessThan(40);
    expect(state.messages.at(-1).id).toBe(lineId(199));
    expect(Buffer.byteLength(JSON.stringify(state.messages))).toBeLessThan(PAGE_BYTES + 100_000);
  });

  it("walks back page by page to the first line, each line once and in order", async () => {
    const core = await open(150, 30_000);
    const state = await core.chat();
    let ids: string[] = state.messages.map((m: { id: string }) => m.id);
    let more = state.history.hasMore;
    let pages = 0;
    while (more) {
      const page = await core.call({ type: "chat.history", botId: MAIN, before: ids[0] });
      expect(page.messages.length).toBeGreaterThan(0);
      expect(page.messages.at(-1).id).not.toBe(ids[0]);
      ids = [...page.messages.map((m: { id: string }) => m.id), ...ids];
      more = page.hasMore;
      expect(++pages).toBeLessThan(60);
    }
    expect(pages).toBeGreaterThan(1);
    expect(ids).toEqual(Array.from({ length: 150 }, (_, n) => lineId(n)));
  });

  it("loads back to a line asked for, however far, and says when it is not older than the page", async () => {
    const core = await open(200, 40_000);
    const state = await core.chat();
    const first = state.messages[0].id;
    const page = await core.call({ type: "chat.history", botId: MAIN, before: first, until: lineId(3) });
    expect(page.found).toBe(true);
    expect(page.messages[0].id).toBe(lineId(3));
    expect(page.messages.at(-1).id).toBe(lineId(Number.parseInt(first.slice(-12), 16) - 1));
    // A line already loaded (or newer than `before`) is not found in the older page; one that is gone neither.
    expect((await core.call({ type: "chat.history", botId: MAIN, before: first, until: lineId(199) })).found).toBe(false);
    expect((await core.call({ type: "chat.history", botId: MAIN, before: first, until: lineId(9999) })).found).toBe(false);
    await expect(core.call({ type: "chat.history", botId: MAIN, before: lineId(9999) })).rejects.toThrow("not_found");
  });

  it("keeps reactions, choices and reply links working on lines that are not loaded", async () => {
    const dir = tempDir("history");
    mkdirSync(join(dir, "main"), { recursive: true });
    const lines: Record<string, unknown>[] = chat(120, 40_000);
    lines[2] = { ...lines[2], role: "bot", choices: [{ label: "Yes" }, { label: "No" }], state: "done" };
    lines[100] = { ...lines[100], replyTo: lineId(2), replyPreview: "#2" };
    writeFileSync(join(dir, "main", "chat.json"), JSON.stringify(lines));
    const core = new CoreHarness(dir);
    harnesses.push(core);
    const state = await core.chat();
    expect(state.messages.some((m: { id: string }) => m.id === lineId(2))).toBe(false);
    // A reaction on a line in an old page is stored, and shows when that page is loaded.
    expect(await core.call({ type: "chat.react", botId: MAIN, messageId: lineId(2), emoji: "👍", present: true })).toEqual({ changed: true });
    const page = await core.call({ type: "chat.history", botId: MAIN, before: state.messages[0].id, until: lineId(2) });
    const old = page.messages.find((m: { id: string }) => m.id === lineId(2));
    expect(old.reactions).toEqual([{ emoji: "👍", actor: "user" }]);
    expect(old.choices).toHaveLength(2);
    // The answer to its choices is accepted too (the question is older than the page).
    expect(await core.call({ type: "chat.choose", botId: MAIN, messageId: lineId(2), index: 0, text: "Yes" })).toHaveProperty("accepted");
    // The reply to it, in the newest page, still names it, and `until` finds it for a jump.
    const reply = state.messages.find((m: { id: string }) => m.id === lineId(100));
    expect(reply?.replyTo).toBe(lineId(2));
  });
});
