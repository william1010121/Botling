// A bot's @ may name a sub bot by its full path, @Parent/Sub: two bots with the same name are told apart that way.
// A plain @Sub still works while exactly one bot this chat can reach has that name. Another bot's sub bot stays
// out of reach, path or not.
import { describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import type { Bot, GuestAnswer } from "../../src/core/bot";
import { saveProjectRow } from "../../src/core/projects";
import { projectProfile } from "../../src/core/store/workspace";
import { mentionNames } from "../../src/renderer/payload";
import { tempDir } from "../helpers";

const BOTLING = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const FLUX = "6AC64E3A-C7D7-4000-8000-000000000001";
const DEPLOYER = "A1B2C3D4-0000-4000-8000-0000000000F1";
const TLA = "5BCFDC3A-0ABD-4167-96AE-9923D1EF8293";
const TLA2 = "5BCFDC3A-0ABD-4167-96AE-9923D1EF8294";
const FLUX_TLA = "5BCFDC3A-0ABD-4167-96AE-9923D1EF8295";
const TLA_PROJECT = "6AC64E3A-C7D7-4000-8000-000000000007";

function fixture({ tlaProject = false } = {}) {
  const dir = tempDir("at-path");
  const folder = tempDir("at-path-botling");
  const fluxFolder = tempDir("at-path-flux");
  for (const f of [folder, fluxFolder]) mkdirSync(join(f, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: BOTLING, name: "botling", folder, avatar: "triangle" });
  saveProjectRow(dir, { id: FLUX, name: "Flux 部署", folder: fluxFolder, avatar: "cloud" });
  saveProjectRow(dir, { id: DEPLOYER, name: "deployer", folder: fluxFolder, avatar: "cloud", job: "Deploy", parent: FLUX, createdAt: 1_700_000_000_000, handoff: "f1" });
  // A project bot of its own named "TLA", like botling's sub bot below.
  if (tlaProject) saveProjectRow(dir, { id: TLA_PROJECT, name: "TLA", folder: fluxFolder, avatar: "cloud" });
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  const bots: Map<string, Bot> = (core as any).bots;
  const conversations = (core as any).conversations;
  const caller = bots.get(BOTLING)!;
  const notices: string[] = [];
  vi.spyOn(caller, "appNotice").mockImplementation(((text: string) => { notices.push(text); return "n"; }) as any);
  vi.spyOn(caller, "appMessage").mockImplementation((() => {}) as any);
  /** A sub bot added after the Core started, attached as the app does. */
  const sub = (id: string, name: string, parent: string, at: string) => {
    const row = { id, name, folder: at, avatar: "triangle", job: "Specs", parent, createdAt: 1_700_000_000_000, handoff: id.slice(-2) };
    saveProjectRow(dir, row);
    (core as any).attach(projectProfile(dir, { ...row, folder: "file://" + at, createdAt: 1 }));
    return held(bots.get(id)!);
  };
  return { core, conversations, caller, notices, sub, folder, fluxFolder };
}

/** A groupTurn that records what it was asked and never answers. */
function held(bot: Bot) {
  const asked: string[] = [];
  vi.spyOn(bot, "groupTurn").mockImplementation((text: string) => { asked.push(text); return new Promise<GuestAnswer>(() => {}); });
  return { asked };
}

const say = (h: ReturnType<typeof fixture>, id: string, text: string) => h.conversations.receiveBotMention({ id, role: "bot", text, date: 0 }, h.caller);

describe("@Parent/Sub", () => {
  it("two of the chat's own reachable bots named alike: a plain @ says which full names to write and sends nothing", async () => {
    const h = fixture({ tlaProject: true });
    try {
      // The project bot "TLA" and botling's own sub bot "TLA".
      const a = h.sub(TLA, "TLA", BOTLING, h.folder);
      const b = held((h.core as any).bots.get(TLA_PROJECT));
      say(h, "R1", "@TLA 請確認 spec");
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).not.toMatch(/more than one bot at the start of a line/);
      expect(h.notices[0]).toMatch(/named "TLA"/i);
      expect(h.notices[0]).toContain("@botling/TLA");
      expect(a.asked).toEqual([]);
      expect(b.asked).toEqual([]);
      // Its path reaches the sub bot.
      say(h, "R2", "@botling/TLA 請確認 spec");
      await vi.waitFor(() => expect(a.asked).toHaveLength(1));
      expect(b.asked).toEqual([]);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("the full path reaches that sub bot, any case, and the body is what follows the path", async () => {
    const h = fixture();
    try {
      const a = h.sub(TLA, "TLA", BOTLING, h.folder);
      h.sub(FLUX_TLA, "TLA", FLUX, h.fluxFolder);
      say(h, "R1", "@BOTLING/tla：請確認 spec\n第二行");
      await vi.waitFor(() => expect(a.asked).toHaveLength(1));
      expect(a.asked[0]).toContain("請確認 spec\n第二行");
      expect(h.conversations.mentionLog.records.at(-1)).toMatchObject({ recipient: TLA, body: "請確認 spec\n第二行" });
      expect(h.notices).toEqual([]);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("a plain @Sub still reaches the one reachable bot with that name (another bot's same-named sub bot does not count)", async () => {
    const h = fixture();
    try {
      const a = h.sub(TLA, "TLA", BOTLING, h.folder);
      const other = h.sub(FLUX_TLA, "TLA", FLUX, h.fluxFolder);
      say(h, "R1", "@TLA 請確認 spec");
      await vi.waitFor(() => expect(a.asked).toHaveLength(1));
      expect(other.asked).toEqual([]);
      expect(h.notices).toEqual([]);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("two own sub bots with the same name: the path is ambiguous too, and the notice says to rename one", async () => {
    const h = fixture();
    try {
      h.sub(TLA, "TLA", BOTLING, h.folder);
      h.sub(TLA2, "TLA", BOTLING, h.folder);
      say(h, "R1", "@botling/TLA 請確認");
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toMatch(/rename/i);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("another bot's sub bot by its path (a parent name with spaces and CJK) is still not callable here", () => {
    const h = fixture();
    try {
      say(h, "R1", "@Flux 部署/deployer 請部署");
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toMatch(/Not sent to Flux 部署\/deployer with @: it is not a bot this chat can call in/);
    } finally { vi.restoreAllMocks(); }
  });

  it("two different bots in one reply are still refused as one reply naming more than one bot", () => {
    const h = fixture();
    try {
      h.sub(TLA, "TLA", BOTLING, h.folder);
      say(h, "R1", "@botling/TLA one\n\n@Flux 部署 two");
      expect(h.notices).toEqual(["Not sent with @: this reply names more than one bot at the start of a line. Name one bot per reply."]);
    } finally { vi.restoreAllMocks(); }
  });

  it("the user's own @ in the composer reaches a sub bot by its path", () => {
    const h = fixture();
    try {
      h.sub(TLA, "TLA", BOTLING, h.folder);
      expect(h.conversations.calledIn("@botling/TLA look", BOTLING).map((m: any) => m.id)).toEqual([TLA]);
    } finally { vi.restoreAllMocks(); }
  });
});

describe("the @ menu", () => {
  it("shows the full path for a sub bot whose name another bot also has", () => {
    const view = (id: string, name: string, parent: string | null = null) => ({ id, name, parent }) as any;
    const bots = [view(BOTLING, "botling"), view(FLUX, "Flux 部署"), view(TLA, "TLA", BOTLING), view(FLUX_TLA, "TLA", FLUX), view(DEPLOYER, "deployer", FLUX)];
    expect(mentionNames(bots[0], bots).allMentions).toEqual(["Flux 部署", "botling/TLA", "Flux 部署/TLA", "deployer"]);
  });
});
