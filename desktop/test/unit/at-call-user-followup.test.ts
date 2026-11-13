// The user @-calls another bot from a bot's chat for real work; the called bot hands it to a worker and its call-in
// turn ends. The worker's result comes later, to the called bot's own chat, and its reply there (a picture and a
// card) must also show in the chat where the user asked. The case is make_flowchart on 2026-11-13 14:09: the user
// asked in botling's chat "@make_flowchart 幫我畫一個現在的進度"; at 14:12 the finished picture and its choices
// showed only in make_flowchart's own chat ("畫好的圖會出現在我自己的對話裡"), never in botling's.
import { describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import type { Bot } from "../../src/core/bot";
import { callInWorkNote } from "../../src/core/groups";
import { saveProjectRow } from "../../src/core/projects";
import { isOpenQuestion } from "../../src/core/store/records";
import { tempDir } from "../helpers";

const BOTLING = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const FLOW = "6AC64E3A-C7D7-4000-8000-0000000000F1";
const PICTURE = "![Botling 快取：做到哪裡了](file:///Users/x/docs/make_flowchart/samples/botling-cache-progress.png)";

function fixture() {
  const dir = tempDir("at-call-user");
  const folder = tempDir("at-call-user-botling");
  const flowFolder = tempDir("at-call-user-flow");
  for (const f of [folder, flowFolder]) mkdirSync(join(f, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: BOTLING, name: "botling", folder, avatar: "triangle" });
  saveProjectRow(dir, { id: FLOW, name: "make_flowchart", folder: flowFolder, avatar: "cloud" });
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  const bots: Map<string, Bot> = (core as any).bots;
  const conversations = (core as any).conversations;
  const caller = bots.get(BOTLING)!, flow = bots.get(FLOW)!;
  const woken: string[] = [];
  vi.spyOn(caller, "appMessage").mockImplementation(((text: string) => { woken.push(text); return "m"; }) as any);
  vi.spyOn(caller as any, "deliver").mockImplementation(async () => {});
  vi.spyOn(flow as any, "deliver").mockImplementation(async () => {});
  return { core, conversations, caller, flow, woken };
}

async function answer(bot: Bot, text: string, origin?: string) {
  await vi.waitFor(() => expect((bot as any).turn?.open && (!origin || (bot as any).turn.origin === origin)).toBe(true));
  const turn = (bot as any).turn;
  turn.reply.text = text;
  (bot as any).finishTurn(turn, "done");
}

/** The user's @ in botling's chat; make_flowchart starts a worker in its call-in turn; later it answers the report. */
async function userCallInWithWorker(h: ReturnType<typeof fixture>) {
  (h.caller as any).add({ id: "U1", role: "user", text: "你可以幫我用 @make_flowchart 幫我畫一個現在的進度跟做了什麼嗎。", date: 0 });
  h.conversations.startCallIn(h.caller, [{ id: FLOW, name: "make_flowchart" }], "U1", null);
  await vi.waitFor(() => expect((h.flow as any).turn?.callIn).toBe(BOTLING));
  (h.flow as any).onWorkerOutput({ kind: "subagentStarted", id: "W1", description: "flowchart", type: "claude-worker", prompt: "Draw.", background: true });
  await answer(h.flow, "我已經派 worker 開工。");
  await vi.waitFor(() => expect(h.caller.lines().some((l) => l.sourceID === FLOW && l.text === "我已經派 worker 開工。")).toBe(true));
  (h.flow as any).workerReport("<app_task_result task_id=\"W1\">done</app_task_result>", "W1");
  await answer(h.flow, `Botling 快取進度圖畫好了。\n\n${PICTURE}\n\n剩下的黃色那項要你決定。\n<choices>\n- 交給 Botling 開工做這一項\n- 也先不做\n</choices>`, "app");
  const original = h.flow.lines().find((l) => l.role === "bot" && l.choices?.length)!;
  expect(original).toBeTruthy();
  return { original };
}

describe("a bot the user @-called: its later reply on its worker's result shows where the user asked", () => {
  it("the picture and its choices are posted in the caller's chat, and a pick there reaches the called bot", async () => {
    const h = fixture();
    try {
      const { original } = await userCallInWithWorker(h);
      const copy = await vi.waitFor(() => {
        const line = h.caller.lines().find((l) => l.role === "bot" && l.sourceID === FLOW && l.choices?.length);
        expect(line).toBeTruthy();
        return line!;
      });
      expect(copy.text).toContain(PICTURE);
      expect(copy.choices!.map((c) => c.label)).toEqual(["交給 Botling 開工做這一項", "也先不做"]);
      // The user asked, not botling's bot: it is not woken as if it had asked make_flowchart itself.
      expect(h.woken.some((text) => text.includes("sent news on that request"))).toBe(false);
      // A pick on the copy goes to make_flowchart, the bot that asked it (called into botling's chat with it).
      expect((h.core as any).calledInPick(BOTLING, copy.id, 0)).toEqual({ accepted: true });
      await vi.waitFor(() => expect((h.flow as any).turn?.callIn).toBe(BOTLING));
      await answer(h.flow, "好，我轉給 Botling。");
      await vi.waitFor(() => expect(h.caller.line(copy.id)!.chosen).toBe(0));
      // Its own card in its own chat shows the same answer.
      await vi.waitFor(() => expect(h.flow.line(original.id)!.chosen).toBe(0));
      expect(isOpenQuestion(h.flow.line(original.id)!)).toBe(false);
      // botling's bot was not handed the pick as its own message.
      expect(h.caller.lines().some((l) => l.role === "user" && l.text === "交給 Botling 開工做這一項")).toBe(false);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("a pick on its own card in its own chat settles the copy in the caller's chat", async () => {
    const h = fixture();
    try {
      const { original } = await userCallInWithWorker(h);
      const copy = await vi.waitFor(() => { const l = h.caller.lines().find((x) => x.sourceID === FLOW && x.choices?.length); expect(l).toBeTruthy(); return l!; });
      expect(h.flow.choose(original.id, 1)).toMatchObject({ accepted: true });
      await vi.waitFor(() => expect(h.caller.line(copy.id)!.chosen).toBe(1));
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("the called bot is not told to promise the result only in its own chat", () => {
    const note = callInWorkNote();
    expect(note).not.toMatch(/its result will show in your own chat/);
    expect(note).toMatch(/also shows? your replies on it in this chat/);
  });
});
