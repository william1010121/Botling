// botling.git's program part against a fake Botling API: what it tells the core about each bot's session folder (when it loads, when
// a worktree is made or dropped, when the toggle changes), what it exposes to its frames, and the turns it records.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BotlingApi, SessionBot, SessionFolder } from "../../../../Web/host/src/api";
import { activate } from "../src/host";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function fake(settings: Record<string, unknown> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botling-git-host-"))); dirs.push(dir);
  const repo = join(dir, "repo"); mkdirSync(repo);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "T"); git(repo, "config", "user.email", "t@example.invalid");
  writeFileSync(join(repo, "a"), "a"); git(repo, "add", "."); git(repo, "commit", "-m", "a");
  const bot: SessionBot = { id: "B1", name: "Site", role: "manager", parent: null, folder: repo, memoryPath: ".bot/memory.md", storeDir: join(dir, "store"), problem: null, workRoot: null };
  const exposed = new Map<string, (params: unknown) => unknown>();
  const events = new Map<string, (data: any) => void>();
  const changes = new Map<string, (value: unknown) => void>();
  const set: [string, SessionFolder | null, unknown][] = [], synced: Record<string, SessionFolder>[] = [], sent: unknown[][] = [], updated: [string, unknown][] = [];
  const api = {
    subscriptions: [] as (() => void)[],
    plugin: { name: "botling.git", version: "1", dir, storageDir: join(dir, "storage"), appDataDir: join(dir, "data") },
    sessions: {
      bots: async () => [bot],
      setFolder: async (id: string, folder: SessionFolder | null, reason?: unknown) => { set.push([id, folder, reason]); },
      syncFolders: async (folders: Record<string, SessionFolder>) => { synced.push(folders); },
    },
    settings: {
      get: (key: string) => settings[key],
      update: async (key: string, value: unknown) => { updated.push([key, value]); settings[key] = value; },
      onChange: (key: string, fn: (value: unknown) => void) => { changes.set(key, fn); return () => {}; },
      app: () => "en",
    },
    events: { on: (name: string, fn: (data: any) => void) => { events.set(name, fn); return () => {}; } },
    ui: { expose: (method: string, fn: (params: unknown) => unknown) => { exposed.set(method, fn); return () => {}; } },
    bots: { send: async (...args: unknown[]) => { sent.push(args); return { messageId: "M" }; } },
  };
  const call = (method: string, params: Record<string, unknown> = {}) => Promise.resolve(exposed.get(method)!({ botId: "B1", ...params })) as Promise<any>;
  return { api: api as unknown as BotlingApi, call, exposed, events, changes, set, synced, sent, updated, bot, dir, repo };
}

it("tells the core every bot's folder when it loads (none while no worktree is current) and exposes what its frames call", async () => {
  const f = fake();
  await activate(f.api);
  expect(f.synced).toEqual([{}]);
  expect([...f.exposed.keys()].sort()).toEqual(["chat.send", "lang", "pr.create", "pr.draft", "review.diff", "review.files", "review.open", "review.target", "settings", "settings.set",
    "worktrees.commit", "worktrees.create", "worktrees.discard", "worktrees.list", "worktrees.merge", "worktrees.terminal", "worktrees.use"]);
  await expect(f.call("worktrees.list", { botId: "nobody" })).rejects.toThrow("No such project");
  expect(await f.call("lang")).toBe("en");
});

it("a new worktree becomes the bot's session folder with the note it hears at each wake; going back to the project folder takes it away", async () => {
  const f = fake({ "botling.git.root": join(mkdtempSync(join(tmpdir(), "botling-git-root-")), "trees") });
  await activate(f.api);
  expect(await f.call("worktrees.create", { name: "Fix it" })).toMatchObject({ ok: true });
  const [id, folder, reason] = f.set.at(-1)!;
  expect(id).toBe("B1");
  expect(folder!.cwd).toContain("fix-it");
  expect(folder!.addDirs).toEqual([join(f.repo, ".bot")]);
  expect(folder!.note).toMatch(/^\(App: Worktree\. The app made a git worktree for this work/);
  expect(folder!.note).toContain(`branch bot/fix-it, folder ${folder!.cwd}`);
  expect(reason).toEqual({ told: "you now work in a new git worktree; see the Worktree note", shown: "Made bot/fix-it from main." });
  const listed = await f.call("worktrees.list");
  expect(listed.current).toBe(listed.items[0].id);

  expect(await f.call("worktrees.use", { worktreeId: null })).toMatchObject({ ok: true });
  expect(f.set.at(-1)).toEqual(["B1", null, { told: "your working directory changed; see the Worktree note", shown: "Back in the project folder." }]);
  rmSync(join(folder!.cwd, ".."), { recursive: true, force: true });
});

it("tells the core again when the toggle changes (back to project folders when off), and keeps the settings it is given", async () => {
  const f = fake({ "botling.git.root": join(mkdtempSync(join(tmpdir(), "botling-git-root-")), "trees") });
  await activate(f.api);
  await f.call("worktrees.create", { name: "x" });
  expect(await f.call("settings")).toMatchObject({ enabled: true });
  f.changes.get("botling.git.enabled")!(false);
  await vi.waitFor(() => expect(f.synced.at(-1)).toEqual({}));
  expect(await f.call("worktrees.list")).toMatchObject({ enabled: false, available: false });
  expect(await f.call("settings.set", { root: " /elsewhere " })).toEqual({ enabled: false, root: "/elsewhere" });
  expect(f.updated.at(-1)).toEqual(["botling.git.root", "/elsewhere"]);
  f.changes.get("botling.git.enabled")!(true);
  await vi.waitFor(() => expect(Object.keys(f.synced.at(-1)!)).toEqual(["B1"]));
});

it("sends review comments as the user, and keeps where the Review tab looks (with a stamp so an open tab notices)", async () => {
  const f = fake();
  await activate(f.api);
  await f.call("chat.send", { text: "In a.ts:1 …" });
  expect(f.sent).toEqual([["B1", "In a.ts:1 …", { as: "user" }]]);
  expect(await f.call("review.target")).toEqual({ bot: { id: "B1", name: "Site" }, target: { worktreeId: null, branch: null, base: null, path: null }, stamp: 0 });
  await f.call("review.open", { target: { worktreeId: "w1", branch: "bot/x", base: "main", path: "/w/x" } });
  expect(await f.call("review.target")).toMatchObject({ target: { worktreeId: "w1" }, stamp: 1 });
  await f.call("review.open", { target: { worktreeId: null } });
  expect(await f.call("review.target")).toMatchObject({ stamp: 2 });
});

it("records a turn's tree when it starts in a worktree, and refuses a revision that is not one", async () => {
  const f = fake({ "botling.git.root": join(mkdtempSync(join(tmpdir(), "botling-git-root-")), "trees") });
  await activate(f.api);
  await f.call("worktrees.create", { name: "turns" });
  const tree = (await f.call("worktrees.list")).items[0];
  f.events.get("turnStarted")!({ botId: "B1", turnId: "T1" });
  await vi.waitFor(async () => expect((await f.call("review.files", { worktreeId: tree.id, scope: "branch" })).turns).toHaveLength(1));
  await expect(f.call("review.diff", { worktreeId: tree.id, from: "../etc", to: "", path: "a" })).rejects.toThrow("Not a revision");
  await expect(f.call("worktrees.merge", { worktreeId: 7 })).rejects.toThrow("Not a request");
  rmSync(join(tree.path, ".."), { recursive: true, force: true });
});
