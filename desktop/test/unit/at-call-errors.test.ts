// A bot's @ that fails tells the bot itself, not only the chat: the caller's next turn carries a line saying
// which @ was not delivered and why (unknown name, not callable here, dropped, callee gone or failed).
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

const BOTLING_SUB = "5BCFDC3A-0ABD-4167-96AE-9923D1EF8293";
/** What the caller bot's next turn would be told about its failed @s (callInStatus is read once per turn). */
const told = (h: ReturnType<typeof fixture>) => h.conversations.callInStatus(BOTLING) as string | null;

describe("an @ that fails is told to the caller bot", () => {
  it("a name no bot has (a sub bot that was closed) says so to the chat and to the caller", () => {
    const h = fixture();
    try {
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: "@TLA 請確認 spec", date: 0 }, h.caller);
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toMatch(/TLA/);
      const note = told(h);
      expect(note).toMatch(/^\(App: .*TLA/);
      expect(note).toMatch(/not delivered|Not sent/i);
      // Told once.
      expect(told(h)).toBeNull();
    } finally { vi.restoreAllMocks(); }
  });

  it("a sub bot of the caller itself is called, so there is nothing to tell", async () => {
    const h = fixture();
    try {
      saveProjectRow(h.dir, { id: BOTLING_SUB, name: "TLA", folder: (h.caller as any).profile.folder, avatar: "triangle", job: "Specs", parent: BOTLING, createdAt: 1_700_000_000_000, handoff: "t1" });
      // Registered later than the Core: attach it as the app does.
      (h.core as any).attach((await import("../../src/core/store/workspace")).projectProfile(h.dir, { id: BOTLING_SUB, name: "TLA", folder: "file://" + (h.caller as any).profile.folder, avatar: "triangle", job: "Specs", parent: BOTLING, createdAt: 1, handoff: "t1" }));
      const tla = held(h.bots.get(BOTLING_SUB)!);
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: "@TLA 請確認 spec", date: 0 }, h.caller);
      await vi.waitFor(() => expect(tla.asked).toHaveLength(1));
      expect(h.notices).toEqual([]);
      expect(told(h)).not.toMatch(/not delivered/i);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("another project's sub bot, a dropped repeat and the depth limit are told to the caller", () => {
    const h = fixture();
    try {
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: "@deployer 請部署", date: 0 }, h.caller);
      expect(told(h)).toMatch(/deployer/);
      h.conversations.followUps.set(BOTLING, { depth: 2, until: Date.now() + 60_000 });
      h.conversations.receiveBotMention(reply("R2", "請部署 2.3.3"), h.caller);
      expect(told(h)).toMatch(/flux-k8s/);
    } finally { vi.restoreAllMocks(); }
  });

  it("a callee that is gone or whose turn fails is told to the caller", async () => {
    const h = fixture();
    try {
      vi.spyOn(h.flux, "groupTurn").mockRejectedValue(new Error("spawn claude ENOENT"));
      h.conversations.receiveBotMention(reply("R1", "請 build 2.3.3"), h.caller);
      await vi.waitFor(() => expect(h.notices).toHaveLength(1));
      expect(told(h)).toMatch(/flux-k8s.*spawn claude ENOENT/);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("an @ the user typed that fails tells no bot (only a bot's own @ has a caller)", async () => {
    const h = fixture();
    try {
      vi.spyOn(h.flux, "groupTurn").mockRejectedValue(new Error("boom"));
      h.conversations.startCallIn(h.caller, [{ id: FLUX, name: "flux-k8s" }], null, "hello");
      await vi.waitFor(() => expect(h.notices).toHaveLength(1));
      expect(told(h)).toBeNull();
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });
});
