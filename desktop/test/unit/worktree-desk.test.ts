import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeDesk } from "../../src/core/worktree-desk";
import type { BotProfile } from "../../src/core/store/workspace";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function setup(settings = { enabled: true, root: null as string | null }, developer = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botling-desk-"))); dirs.push(dir);
  const folder = join(dir, "repo"); mkdirSync(folder);
  git(folder, "init", "-b", "main"); git(folder, "config", "user.name", "T"); git(folder, "config", "user.email", "t@example.invalid");
  writeFileSync(join(folder, "a"), "a"); git(folder, "add", "."); git(folder, "commit", "-m", "a");
  const profile: BotProfile = { id: "ID1", name: "P", role: "manager", avatar: "hexagon", folder, memoryPath: ".bot/memory.md", storeDir: join(dir, "store"), tools: [], job: null, problem: null };
  const moved: string[] = [], opened: string[] = [];
  const desk = new WorktreeDesk({
    dataDir: join(dir, "data"), settings: () => settings, devWork: () => join(dir, "work-drive"), isDeveloper: () => developer,
    moved: (id) => moved.push(id), openTerminal: async (path) => { opened.push(path); },
  });
  return { dir, profile, desk, moved, opened };
}

describe("worktree desk", () => {
  it("picks the folder: the setting, else the work drive for the developer project, else the data folder", () => {
    const a = setup({ enabled: true, root: "/custom" }, true), b = setup(undefined, true), c = setup();
    expect(a.desk.root(a.profile)).toBe("/custom");
    expect(b.desk.root(b.profile)).toBe(join(b.dir, "work-drive"));
    expect(c.desk.root(c.profile)).toBe(join(c.dir, "data", "worktrees", "ID1"));
  });

  it("keeps the project folder as the session folder until a worktree is made, and says so to the agent after", async () => {
    const { desk, profile, moved } = setup();
    expect(desk.sessionFolder(profile)).toBe(profile.folder);
    expect(desk.note(profile)).toBe("");
    expect(desk.extraDirs(profile)).toEqual([]);
    expect(await desk.create(profile, "Fix it")).toMatchObject({ ok: true });
    expect(moved).toEqual(["ID1"]);
    const folder = desk.sessionFolder(profile);
    expect(folder).not.toBe(profile.folder);
    expect(desk.extraDirs(profile)).toEqual([join(profile.folder, ".bot")]);
    expect(desk.note(profile)).toContain(`branch bot/fix-it, folder ${folder}`);
    expect(desk.note(profile)).toContain(join(profile.folder, ".bot", "memory.md"));
    expect(desk.note(profile)).toMatch(/already inside that worktree .*use relative paths, do not cd to the project folder/);
    expect((await desk.use(profile, null)).ok).toBe(true);
    expect(desk.sessionFolder(profile)).toBe(profile.folder);
  });

  it("is inert when the setting is off or the bot is the main bot", async () => {
    const off = setup({ enabled: false, root: null });
    expect(await off.desk.create(off.profile, "x")).toMatchObject({ ok: false });
    expect(await off.desk.view(off.profile)).toMatchObject({ enabled: false, available: false });
    const on = setup();
    expect(await on.desk.view({ ...on.profile, role: "main" })).toMatchObject({ available: false });
  });

  it("asks before discarding work, and opens a terminal only on a worktree that is there", async () => {
    const { desk, profile, opened } = setup();
    await desk.create(profile, "t");
    const item = (await desk.view(profile)).items[0]!;
    writeFileSync(join(item.path, "wip"), "x");
    expect(await desk.discard(profile, item.id, false)).toMatchObject({ ok: false, confirm: true });
    expect(await desk.terminal(profile, item.id)).toMatchObject({ ok: true });
    expect(opened).toEqual([item.path]);
    expect(await desk.terminal(profile, "nope")).toMatchObject({ ok: false });
    expect(await desk.discard(profile, item.id, true)).toMatchObject({ ok: true });
  });
});
