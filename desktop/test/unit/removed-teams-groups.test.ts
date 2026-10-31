// @vitest-environment jsdom
// Temporary teams and "New group" are gone (2.x). What an older Botling left on disk stays untouched
// and must not stop the core from starting; nothing about them is offered to the main bot or the UI.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CoreHarness, MAIN } from "../core-harness";
import { tempDir, swiftLine } from "../helpers";
import { botPrompts } from "../../src/core/prompts";
import { projectBriefingText } from "../../src/core/projects";
import { parseReply } from "../../src/core/reply";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/renderer/App";
import { WorkspaceStore } from "../../src/renderer/store";
import type { Client } from "../../src/renderer/client";
import { Command, RENDERER_COMMANDS } from "../../src/contract";

const running: CoreHarness[] = [];
afterEach(async () => { for (const core of running.splice(0)) await core.kill(); });

const profile = (role: "main" | "manager" | "bot") => ({ name: "Main bot", role, folder: "/tmp/x", memoryPath: "memory.md", job: null, instructions: null });

describe("the main bot is told to use subagents, not teams", () => {
  for (const engine of ["claude", "codex"] as const) {
    it(`no <team> tag or temporary team in the ${engine} main-bot prompt`, () => {
      const prompts = botPrompts({ profile: profile("main"), engine });
      const all = JSON.stringify(prompts);
      expect(all).not.toMatch(/<team\b|temporary team/i);
      if (engine === "claude") expect(JSON.stringify(prompts)).toContain("use a subagent");
    });
  }
  it("the wake briefing lists projects and bots but no teams", () => {
    const row = { name: "Shop", about: "folder /s", memory: "/s/.bot/memory.md", inbox: "/s/.bot/inbox.md", question: null };
    const text = projectBriefingText({ projects: [row], bots: [], maintainer: row });
    expect(text).not.toMatch(/team/i);
  });
  it("a <team> tag is no longer a request", () => {
    expect(parseReply('ok <team name="research">x</team>').requests).toEqual([]);
  });
});

describe("New group is gone", () => {
  it("the left column offers Add project and New bot, but no New group", async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = ((media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} })) as any;
    const bot = { id: "project", name: "Project", role: "manager", avatar: "circle", folder: "/fixture", phase: "awake", working: false, approvals: 0, unread: 0,
      subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
    const snapshot = { epoch: "t", seq: 1, imported: null, components: {}, bots: [bot], chat: null, waiting: { items: [], doing: {} },
      plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null } };
    const store = new WorkspaceStore((async () => snapshot) as never);
    const client = { request: async () => ({}), onEvent: () => () => {} } as unknown as Client;
    const fixture = { store, client }; await fixture.store.resync();
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(App, { client: fixture.client, store: fixture.store })));
      expect(host.textContent).toContain("New bot");
      expect(host.textContent).not.toMatch(/New group|Add a project, a bot or a group/);
      expect(host.querySelector(".new-group-button, .group-row")).toBeNull();
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
  it("the group commands no longer exist in the contract", () => {
    for (const type of ["groups.create", "groups.edit", "groups.delete"]) {
      expect(RENDERER_COMMANDS.has(type as never)).toBe(false);
      expect(Command.safeParse({ type, name: "x", members: [MAIN], groupId: MAIN }).success).toBe(false);
    }
  });
});

describe("old saved groups and teams do not stop the app from starting", () => {
  it("loads a data folder with a group, its chat, a team plugin, runs/ and teams.v1-backup; nothing is deleted", async () => {
    const data = tempDir("old-groups-teams");
    const group = randomUUID().toUpperCase();
    const groupsFile = JSON.stringify([{ id: group, name: "Old crew", members: [MAIN, "DEC0DE00-0000-4000-8000-00000000DEC0"] }, { id: "not-a-uuid", name: "junk" }]);
    writeFileSync(join(data, "groups.json"), groupsFile);
    mkdirSync(join(data, "groups", group), { recursive: true });
    const chat = JSON.stringify([swiftLine({ id: randomUUID(), role: "user", text: "hello crew" })]);
    writeFileSync(join(data, "groups", group, "chat.json"), chat);
    const agents = join(data, "plugins", "ccb-teams", "claude", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "research.md"), "---\nname: research\ntitle: Research team\nmodel: sonnet\ntools: Read\ndescription: old\n---\nrole\n");
    mkdirSync(join(data, "runs", "2026-10-31-research"), { recursive: true });
    mkdirSync(join(data, "teams.v1-backup"), { recursive: true });
    const core = new CoreHarness(data);
    running.push(core);
    const snapshot = await core.call({ type: "chat.snapshot" });
    expect(snapshot.bots.map((bot: { id: string }) => bot.id)).toContain(MAIN);
    expect(snapshot.bots.some((bot: { id: string; role: string }) => bot.id === group || bot.role === "group")).toBe(false);
    expect(snapshot).not.toHaveProperty("teams");
    await expect(core.call({ type: "chat.snapshot", botId: group })).rejects.toThrow(/not_found/);
    // The old files are exactly as they were.
    expect(readFileSync(join(data, "groups.json"), "utf8")).toBe(groupsFile);
    expect(readFileSync(join(data, "groups", group, "chat.json"), "utf8")).toBe(chat);
    expect(existsSync(join(agents, "research.md"))).toBe(true);
    expect(existsSync(join(data, "runs", "2026-10-31-research"))).toBe(true);
    expect(existsSync(join(data, "teams.v1-backup"))).toBe(true);
    // No ccb-teams plugin is made for a fresh folder any more.
    const fresh = tempDir("fresh-no-teams");
    const second = new CoreHarness(fresh);
    running.push(second);
    await second.call({ type: "chat.snapshot" });
    expect(existsSync(join(fresh, "plugins", "ccb-teams"))).toBe(false);
  });
});
