// A call-in under way is seen, and one not sent says why: the caller's chat names who is answering or
// queued (beside its own typing bubble), the callee's own chat and row show it at work, the caller's next
// turn is told which of its @s are still out, and every @ the app drops leaves a notice with the reason.
// The reply shape is botling's of 2026-11-02 13:27: a status line, a hidden <task> line, then the @ paragraph.
import { describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BotView } from "../../src/contract";
import { Core } from "../../src/core/server";
import type { Bot, GuestAnswer } from "../../src/core/bot";
import { saveProjectRow } from "../../src/core/projects";
import { chatState } from "../../src/renderer/payload";
import { tempDir } from "../helpers";

const BOTLING = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const FLUX = "6AC64E3A-C7D7-4000-8000-000000000001";
const DEPLOYER = "A1B2C3D4-0000-4000-8000-0000000000F1";

function fixture() {
  const dir = tempDir("call-in-status");
  const folder = tempDir("call-in-status-botling");
  const fluxFolder = tempDir("call-in-status-flux");
  for (const f of [folder, fluxFolder]) mkdirSync(join(f, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: BOTLING, name: "botling", folder, avatar: "triangle" });
  saveProjectRow(dir, { id: FLUX, name: "flux-k8s", folder: fluxFolder, avatar: "cloud" });
  // flux-k8s's own sub bot: callable in flux-k8s's chat only.
  saveProjectRow(dir, { id: DEPLOYER, name: "deployer", folder: fluxFolder, avatar: "cloud", job: "Deploy", parent: FLUX, createdAt: 1_700_000_000_000, handoff: "f1" });
  const events: any[] = [];
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit(event) { events.push(event); }, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  const bots: Map<string, Bot> = (core as any).bots;
  const conversations = (core as any).conversations;
  const caller = bots.get(BOTLING)!, flux = bots.get(FLUX)!;
  const notices: string[] = [];
  vi.spyOn(caller, "appNotice").mockImplementation(((text: string) => { notices.push(text); return "n"; }) as any);
  vi.spyOn(caller, "appMessage").mockImplementation((() => {}) as any);
  return { dir, core, events, bots, conversations, caller, flux, notices };
}

/** A groupTurn that answers only when told to. */
function held(bot: Bot) {
  const asked: string[] = [];
  const answers: ((answer: GuestAnswer) => void)[] = [];
  vi.spyOn(bot, "groupTurn").mockImplementation((text: string) => { asked.push(text); return new Promise<GuestAnswer>((resolve) => answers.push(resolve)); });
  return { asked, answer: (i: number, text = "Deployed.") => answers[i]!({ kind: "reply", text, steps: [], engine: "claude" }) };
}

const reply = (id: string, ask: string) => ({
  id, role: "bot" as const, date: 0,
  text: ["Docker 已經恢復回應，我現在請 flux-k8s 部署網站。", "", "", "", "v2.3.3 已經 build 好。", "", `@flux-k8s ${ask}`].join("\n"),
});
const view = (h: ReturnType<typeof fixture>, id: string) => h.core.snapshot().bots.find((bot) => bot.id === id)!;

describe("a call-in under way", () => {
  it("the caller's chat names a pending call-in, answering or queued, beside its own typing bubble", async () => {
    const h = fixture();
    try {
      const flux = held(h.flux);
      h.conversations.receiveBotMention(reply("R1", "請部署 2.3.3"), h.caller);
      await vi.waitFor(() => expect(flux.asked).toHaveLength(1));
      h.conversations.receiveBotMention(reply("R2", "還在嗎？請部署 2.3.3"), h.caller);
      const caller = view(h, BOTLING);
      expect(BotView.safeParse(caller).success).toBe(true);
      expect(caller.callIns).toEqual([{ id: FLUX, state: "answering" }, { id: FLUX, state: "queued" }]);
      // The caller's own bot is at work: its typing bubble shows, and the call-ins still do.
      const chat = { botId: BOTLING, messages: [], running: { turnId: "t1", messageId: "m1" }, live: [], tasks: [] };
      const state = chatState(caller, chat as any, new Date(), null, { bots: h.core.snapshot().bots }).state;
      expect(state.working).toBe(true);
      expect(state.callIns).toEqual([{ name: "flux-k8s", state: "answering" }, { name: "flux-k8s", state: "queued" }]);
      flux.answer(0);
      await vi.waitFor(() => expect(flux.asked).toHaveLength(2));
      expect(view(h, BOTLING).callIns).toEqual([{ id: FLUX, state: "answering" }]);
      flux.answer(1);
      await vi.waitFor(() => expect(view(h, BOTLING).callIns ?? []).toEqual([]));
      expect(h.notices).toEqual([]);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("the callee's own chat and row show it at work while it answers a call-in, and only then", async () => {
    const h = fixture();
    try {
      // The turn is begun for real; only handing it to an agent is left out.
      vi.spyOn(h.flux as any, "deliver").mockImplementation(async () => {});
      h.conversations.receiveBotMention(reply("R1", "請部署 2.3.3"), h.caller);
      await vi.waitFor(() => expect((h.flux as any).turn).toBeTruthy());
      const flux = view(h, FLUX);
      expect(flux.working).toBe(true);
      expect(flux.answeringIn).toBe(BOTLING);
      expect(h.events.some(({ event }) => event.type === "bot.updated" && event.bot.id === FLUX && event.bot.working)).toBe(true);
      const own = chatState(flux, { botId: FLUX, messages: [], running: null, live: [], tasks: [] } as any, new Date(), null, { bots: h.core.snapshot().bots }).state;
      expect(own.answeringIn).toBe("botling");
      const turn = (h.flux as any).turn;
      turn.reply.text = "Deployed.";
      (h.flux as any).finishTurn(turn, "done");
      expect(view(h, FLUX).working).toBe(false);
      await vi.waitFor(() => expect(view(h, FLUX).answeringIn ?? null).toBeNull());
      expect(h.events.findLast(({ event }) => event.type === "bot.updated" && event.bot.id === FLUX)?.event.bot).toMatchObject({ working: false, answeringIn: null });
      // Another hidden turn (a spec desk's fill) is still not "at work".
      void h.flux.groupTurn("Fill the spec.", 1_000, 60_000);
      await vi.waitFor(() => expect((h.flux as any).turn).toBeTruthy());
      expect(view(h, FLUX).working).toBe(false);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("the caller's next turn is told which of its @s are still being answered or queued, and not once answered", async () => {
    const h = fixture();
    try {
      const flux = held(h.flux);
      h.conversations.receiveBotMention(reply("R1", "請部署 2.3.3"), h.caller);
      await vi.waitFor(() => expect(flux.asked).toHaveLength(1));
      h.conversations.receiveBotMention(reply("R2", "還在嗎？請部署 2.3.3"), h.caller);
      const compose = (words: string) => (h.caller as any).compose((h.caller as any).newTurn("user", words, null), false) as string;
      const prompt = compose("現在進度？");
      expect(prompt).toMatch(/\(App: "flux-k8s" is still answering your @ from \d\d:\d\d\.\)/);
      expect(prompt).toMatch(/\(App: "flux-k8s" is queued to answer your @ from \d\d:\d\d, after another call-in\.\)/);
      expect(prompt).toContain("現在進度？");
      flux.answer(0);
      await vi.waitFor(() => expect(flux.asked).toHaveLength(2));
      flux.answer(1);
      await vi.waitFor(() => expect(view(h, BOTLING).callIns ?? []).toEqual([]));
      expect(compose("好了嗎？")).not.toContain("is still answering");
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });
});

describe("a bot's @ that the app does not send", () => {
  it("says so when the chain of bots calling each other has gone as far as it may", async () => {
    const h = fixture();
    try {
      const flux = held(h.flux);
      h.conversations.followUps.set(BOTLING, { depth: 2, until: Date.now() + 60_000 });
      h.conversations.receiveBotMention(reply("R1", "請部署 2.3.3"), h.caller);
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toMatch(/^Not sent to flux-k8s with @: /);
      expect(flux.asked).toEqual([]);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("keeps quiet for the same words again while the first is still being answered, and says so once it was", async () => {
    const h = fixture();
    try {
      const flux = held(h.flux);
      h.conversations.receiveBotMention(reply("R1", "請部署 2.3.3"), h.caller);
      await vi.waitFor(() => expect(flux.asked).toHaveLength(1));
      h.conversations.receiveBotMention(reply("R2", "請部署 2.3.3"), h.caller);
      expect(h.notices).toEqual([]);
      flux.answer(0);
      await vi.waitFor(() => expect(view(h, BOTLING).callIns ?? []).toEqual([]));
      h.conversations.receiveBotMention(reply("R3", "請部署 2.3.3"), h.caller);
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toMatch(/^Not sent to flux-k8s with @: .*already/);
      expect(flux.asked).toHaveLength(1);
      // The same reply heard twice is no new @ at all.
      h.conversations.receiveBotMention(reply("R1", "請部署 2.3.3"), h.caller);
      expect(h.notices).toHaveLength(1);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("says so when it names a bot that cannot be called into this chat (another project's sub bot), not when it names itself", async () => {
    const h = fixture();
    try {
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: "@deployer 請部署", date: 0 }, h.caller);
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toMatch(/^Not sent to deployer with @: /);
      h.conversations.receiveBotMention({ id: "R2", role: "bot", text: "@botling 記一下", date: 0 }, h.caller);
      expect(h.notices).toHaveLength(1);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("says so when the bot it named is gone by its turn, or its turn could not start", async () => {
    const h = fixture();
    try {
      const bot = vi.spyOn(h.conversations.deps, "bot").mockReturnValue(null);
      h.conversations.receiveBotMention(reply("R1", "請部署 2.3.3"), h.caller);
      await vi.waitFor(() => expect(h.notices).toHaveLength(1));
      expect(h.notices[0]).toMatch(/flux-k8s/);
      bot.mockRestore();
      vi.spyOn(h.flux, "groupTurn").mockRejectedValue(new Error("spawn claude ENOENT"));
      h.conversations.receiveBotMention(reply("R2", "請 build 2.3.3"), h.caller);
      await vi.waitFor(() => expect(h.notices).toHaveLength(2));
      expect(h.notices[1]).toMatch(/flux-k8s.*spawn claude ENOENT/);
      expect(view(h, BOTLING).callIns ?? []).toEqual([]);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });
});
