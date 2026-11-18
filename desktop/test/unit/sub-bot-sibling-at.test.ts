// A sub bot's @ reaches its sibling sub bots (same project bot) and its project bot, in the sub bot's own chat, the
// way a project bot's @ reaches its own sub bots. Another bot's sub bot stays out of reach. (2026-11-18: the sub bot
// "實習機會研究" wrote "@履歷 ..." to its sibling and the app refused it as "not a bot this chat can call in".)
import { describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import type { Bot, GuestAnswer } from "../../src/core/bot";
import { saveProjectRow } from "../../src/core/projects";
import { projectProfile } from "../../src/core/store/workspace";
import { tempDir } from "../helpers";

const LIFE = "8C103232-E3BC-4956-AE05-A43DD4170644";
const FLUX = "6AC64E3A-C7D7-4000-8000-000000000001";
const RESUME = "B13AE658-103D-45CA-B8FE-22761E9DFD62";
const INTERN = "194328E6-FAAF-4A13-8225-78FF060017B8";
const DEPLOYER = "A1B2C3D4-0000-4000-8000-0000000000F1";
const FLUX_RESUME = "B13AE658-103D-45CA-B8FE-22761E9DFD63";
const ASK = "請用 resume/Sheng_Wei_Kuo_Google_SWE_Intern_2027.pdf 回答兩件事";

/** A groupTurn that records what it was asked and never answers. */
function held(bot: Bot) {
  const asked: string[] = [];
  vi.spyOn(bot, "groupTurn").mockImplementation((text: string) => { asked.push(text); return new Promise<GuestAnswer>(() => {}); });
  return asked;
}

function fixture(remoteMembers?: () => { id: string; name: string; server: string; serverName: string }[]) {
  const dir = tempDir("sibling-at");
  const lifeFolder = tempDir("sibling-at-life");
  const fluxFolder = tempDir("sibling-at-flux");
  for (const f of [lifeFolder, fluxFolder]) mkdirSync(join(f, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: LIFE, name: "Life Bot", folder: lifeFolder, avatar: "triangle" });
  saveProjectRow(dir, { id: FLUX, name: "Flux 部署", folder: fluxFolder, avatar: "cloud" });
  // Two sub bots of Life Bot (siblings), and Flux's own sub bot "deployer".
  for (const [id, name, parent, at] of [[RESUME, "履歷", LIFE, lifeFolder], [INTERN, "實習機會研究", LIFE, lifeFolder], [DEPLOYER, "deployer", FLUX, fluxFolder]] as const) {
    saveProjectRow(dir, { id, name, folder: at, avatar: "triangle", job: "Job", parent, createdAt: 1_700_000_000_000, handoff: id.slice(-2) });
  }
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0,
    ...(remoteMembers ? { remoteMembers } : {}) });
  const bots: Map<string, Bot> = (core as any).bots;
  const conversations = (core as any).conversations;
  const notices: string[] = [];
  const intern = bots.get(INTERN)!;
  vi.spyOn(intern, "appNotice").mockImplementation(((text: string) => { notices.push(text); return "n"; }) as any);
  vi.spyOn(intern, "appMessage").mockImplementation((() => {}) as any);
  /** A sub bot of another project bot with the same name as a sibling, attached as the app does. */
  const cousin = () => {
    const row = { id: FLUX_RESUME, name: "履歷", folder: "x", avatar: "triangle", job: "Job", parent: FLUX, createdAt: 1_700_000_000_000, handoff: "63" };
    saveProjectRow(dir, row);
    (core as any).attach(projectProfile(dir, { ...row, folder: "file://" + fluxFolder, createdAt: 1 }));
    return held(bots.get(FLUX_RESUME)!);
  };
  const say = (id: string, text: string) => conversations.receiveBotMention({ id, role: "bot", text, date: 0 }, intern);
  return { core, conversations, intern, notices, say, cousin, resume: held(bots.get(RESUME)!), deployer: held(bots.get(DEPLOYER)!), life: held(bots.get(LIFE)!) };
}

describe("a sub bot's @ to its sibling sub bots and its project bot", () => {
  it("@履歷 from the sibling sub bot reaches it, with the words after its name, and says nothing is refused", async () => {
    const h = fixture();
    try {
      h.say("R1", `@履歷 使用者想改投 Google Data Center Technician Intern。${ASK}`);
      await vi.waitFor(() => expect(h.resume).toHaveLength(1));
      expect(h.resume[0]).toContain(ASK);
      expect(h.notices).toEqual([]);
      expect(h.conversations.mentionLog.records.at(-1)).toMatchObject({ sender: INTERN, recipient: RESUME });
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("the sibling's full path, @Life Bot/履歷, reaches it too", async () => {
    const h = fixture();
    try {
      h.say("R1", `@Life Bot/履歷 ${ASK}`);
      await vi.waitFor(() => expect(h.resume).toHaveLength(1));
      expect(h.notices).toEqual([]);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("the project bot (its parent) is reached by its name", async () => {
    const h = fixture();
    try {
      h.say("R1", "@Life Bot 履歷那邊問完了");
      await vi.waitFor(() => expect(h.life).toHaveLength(1));
      expect(h.notices).toEqual([]);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("another bot's sub bot is still refused, by name alone and by path, and nothing is sent", () => {
    const h = fixture();
    try {
      h.say("R1", "@deployer 請部署");
      h.say("R2", "@Flux 部署/deployer 請部署");
      expect(h.notices).toHaveLength(2);
      for (const notice of h.notices) expect(notice).toMatch(/with @: it is not a bot this chat can call in/);
      expect(h.deployer).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });

  it("a plain @履歷 means the sibling while another bot's sub bot has the same name, which gets nothing", async () => {
    const h = fixture();
    try {
      const cousin = h.cousin();
      h.say("R1", `@履歷 ${ASK}`);
      await vi.waitFor(() => expect(h.resume).toHaveLength(1));
      expect(cousin).toEqual([]);
      expect(h.notices).toEqual([]);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("the sub bot cannot call itself, and the bots it can call in include its sibling and parent but not another bot's sub bot", () => {
    const h = fixture();
    try {
      const names = h.conversations.callable(INTERN).map((member: { id: string }) => member.id);
      expect(names).toContain(RESUME);
      expect(names).toContain(LIFE);
      expect(names).toContain(FLUX);
      expect(names).not.toContain(INTERN);
      expect(names).not.toContain(DEPLOYER);
    } finally { vi.restoreAllMocks(); }
  });

  it("the sub bot's own @ in its composer reaches the sibling", () => {
    const h = fixture();
    try {
      expect(h.conversations.calledIn("@履歷 看一下", INTERN).map((m: { id: string }) => m.id)).toEqual([RESUME]);
      expect(h.conversations.calledIn("@deployer 看一下", INTERN)).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });

  it("an unknown name lists the sibling among the bots this chat can call in", () => {
    const h = fixture();
    try {
      h.say("R1", "@不存在 你好");
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toContain("@履歷");
      expect(h.notices[0]).not.toContain("@deployer");
    } finally { vi.restoreAllMocks(); }
  });

  it("the sibling's answer is posted in the sub bot's own chat, and a pick on its card goes back to the sibling", async () => {
    const h = fixture();
    try {
      const resume: Bot = (h.core as any).bots.get(RESUME);
      const asked: string[] = [];
      vi.spyOn(resume, "groupTurn").mockImplementation(async (text: string) => {
        asked.push(text);
        return { kind: "reply", text: asked.length === 1 ? "要哪一份？\n<choices>\n- 甲\n- 乙\n</choices>" : "收到。", engine: "claude", steps: [] } as GuestAnswer;
      });
      h.say("R1", `@履歷 ${ASK}`);
      const intern: Bot = (h.core as any).bots.get(INTERN);
      const card = await vi.waitFor(() => { const line = intern.lines().find((l) => l.sourceID === RESUME && l.choices?.length); expect(line).toBeTruthy(); return line!; });
      expect(card.text).toContain("要哪一份");
      // The card is a called-in bot's line in a sub bot's chat: the pick reaches the sibling that asked.
      expect(h.conversations.isCalledIn(card, INTERN)).toBe(true);
      expect((h.core as any).calledInPick(INTERN, card.id, 1)).toEqual({ accepted: true });
      await vi.waitFor(() => expect(asked).toHaveLength(2));
      expect(asked[1]).toContain("乙");
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("a peer bot with the sibling's name does not take the plain @name; @name (machine) still reaches the peer", () => {
    const REMOTE = "6AC64E3A-C7D7-4000-8000-0000000000B1";
    const h = fixture(() => [{ id: REMOTE, name: "履歷", server: "srv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", serverName: "build-box" }]);
    try {
      expect(h.conversations.calledIn("@履歷 看一下", INTERN).map((m: { id: string }) => m.id)).toEqual([RESUME]);
      expect(h.conversations.calledIn("@履歷 (build-box) 看一下", INTERN).map((m: { id: string }) => m.id)).toEqual([REMOTE]);
    } finally { vi.restoreAllMocks(); }
  });
});
