// App-managed worktrees through the real core process and the real plugin host (fake agent, no windows): the session starts in the
// current worktree, keeps the project's .bot reachable, hears about it, and is back in the project folder once the worktree is
// discarded; discarding asks first when work would be lost. The folder is the plugin's to decide (`sessions.folder`), but the core
// answers from memory: after a restart the very first turn already starts in the worktree, before the plugin host has loaded.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir, until } from "../../../test/helpers";
import { CoreHarness } from "../../../test/core-harness";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null) await harness.kill("SIGTERM"); });
const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const BOT = "6A0B0000-0000-4000-8000-0000000000AA";

function project(name: string) {
  const dir = tempDir(name);
  const repo = realpathSync(mkdirSync(join(dir, "repo"), { recursive: true }) ?? join(dir, "repo"));
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "T"); git(repo, "config", "user.email", "t@example.invalid");
  writeFileSync(join(repo, "a.txt"), "a"); git(repo, "add", "."); git(repo, "commit", "-m", "a");
  writeFileSync(join(dir, "projects.json"), JSON.stringify([{ id: BOT, name: "Proj", folder: pathToFileURL(repo).href + "/", avatar: "hexagon" }]));
  return { dir, repo };
}

/** A command of botling.git's program part, as its frames make it (retried while the plugin host is still loading it). */
const frame = (c: CoreHarness) => async (method: string, params: Record<string, unknown> = {}): Promise<any> => {
  const answer = await until(async () => { try { return await c.call({ type: "plugins.call", name: "botling.git", method, params: { botId: BOT, ...params }, from: "frame" }); } catch (error) { if (/not on|not running|No command|not found|unknown method/i.test(String((error as Error).message))) return null; throw error; } }, { timeout: 20_000, what: `botling.git ${method}` });
  return answer.result;
};

describe("worktrees through botling.git", () => {
  it("starts the session in the current worktree, then back in the project folder after a discard", async () => {
    const { dir, repo } = project("wt-session");
    const c = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir, "start.log"), FAKE_CLAUDE_INPUT: join(dir, "input.log") });
    harnesses.push(c);
    const root = join(dir, "wt-root");
    const ask = frame(c);
    await c.call({ type: "plugins.setting", name: "botling.git", key: "botling.git.root", value: root });
    const send = async (text: string) => { const sent = await c.call({ type: "chat.send", botId: BOT, text }); await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId)); };

    await until(async () => (await ask("settings")).root === root, { timeout: 20_000, what: "the root setting reaching the plugin" });
    expect(await ask("worktrees.list")).toMatchObject({ enabled: true, available: true, current: null, items: [] });
    await send("hello");
    expect(realpathSync(lines(join(dir, "start.log")).at(-1).cwd)).toBe(repo);

    expect(await ask("worktrees.create", { name: "Try it" })).toMatchObject({ ok: true });
    const listed = await ask("worktrees.list");
    expect(listed.items).toHaveLength(1);
    const tree = listed.items[0];
    expect(tree).toMatchObject({ branch: "bot/try-it", status: "active", base: "main", changedFiles: 0, ahead: 0 });
    expect(tree.path.startsWith(realpathSync(dir))).toBe(true);

    await send("work in the tree");
    const second = lines(join(dir, "start.log")).at(-1);
    expect(realpathSync(second.cwd)).toBe(tree.path);
    expect(second.args).toContain("--add-dir");
    expect(second.args[second.args.indexOf("--add-dir") + 1]).toBe(join(repo, ".bot"));
    expect(lines(join(dir, "input.log")).some((entry) => String(entry.text).includes("(App: Worktree.") && String(entry.text).includes(tree.path))).toBe(true);
    expect(git(repo, "status", "--porcelain", "--", ".", ":!.bot")).toBe("");

    // The review sees the worktree's changes, and the turn that started above was recorded by the real turn event.
    writeFileSync(join(tree.path, "review-me.txt"), "r\n");
    const review = await ask("review.files", { worktreeId: tree.id, scope: "branch" });
    expect(review).toMatchObject({ ok: true, base: "main" });
    expect(review.files.map((f: any) => f.path)).toEqual(["review-me.txt"]);
    await until(async () => (await ask("review.files", { worktreeId: tree.id, scope: "branch" })).turns.length >= 1);
    const turn = (await ask("review.files", { worktreeId: tree.id, scope: "branch" })).turns[0];
    expect((await ask("review.files", { worktreeId: tree.id, scope: "turn", turn: turn.id })).files.map((f: any) => f.path)).toEqual(["review-me.txt"]);
    expect(await ask("review.diff", { worktreeId: null, from: "", to: review.to, path: "../x" })).toMatchObject({ ok: false });

    // Work that would be lost needs a confirmation; then the session is back in the project folder.
    writeFileSync(join(tree.path, "wip.txt"), "wip");
    expect(await ask("worktrees.discard", { worktreeId: tree.id })).toMatchObject({ ok: false, confirm: true });
    expect(existsSync(join(tree.path, "wip.txt"))).toBe(true);
    expect(await ask("worktrees.discard", { worktreeId: tree.id, force: true })).toMatchObject({ ok: true });
    await send("back");
    expect(realpathSync(lines(join(dir, "start.log")).at(-1).cwd)).toBe(repo);
    expect(git(repo, "branch", "--list", "bot/try-it")).toBe("");
  }, 90_000);

  it("after a restart of Botling the first turn already starts in the worktree, whether or not the plugin has loaded yet", async () => {
    const { dir, repo } = project("wt-restart");
    const first = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir, "start.log") });
    harnesses.push(first);
    await first.call({ type: "plugins.setting", name: "botling.git", key: "botling.git.root", value: join(dir, "wt-root") });
    const ask = frame(first);
    await until(async () => (await ask("settings")).root === join(dir, "wt-root"), { timeout: 20_000, what: "the root setting" });
    expect(await ask("worktrees.create", { name: "Keep" })).toMatchObject({ ok: true });
    const tree = (await ask("worktrees.list")).items[0];
    await first.kill("SIGTERM");

    const again = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir, "start2.log") });
    harnesses.push(again);
    const sent = await again.call({ type: "chat.send", botId: BOT, text: "straight away" });
    await until(() => again.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    expect(realpathSync(lines(join(dir, "start2.log")).at(-1).cwd)).toBe(tree.path);
    expect(repo).not.toBe(tree.path);
  }, 90_000);

  it("with the setting off, nothing is listed or made and the session stays in the project folder", async () => {
    const { dir, repo } = project("wt-off");
    const c = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir, "start.log") });
    harnesses.push(c);
    const ask = frame(c);
    await c.call({ type: "plugins.setting", name: "botling.git", key: "botling.git.enabled", value: false });
    await until(async () => (await ask("settings")).enabled === false, { timeout: 20_000, what: "the toggle reaching the plugin" });
    expect(await ask("worktrees.list")).toMatchObject({ enabled: false, available: false, items: [] });
    expect(await ask("worktrees.create", { name: "x" })).toMatchObject({ ok: false });
    const sent = await c.call({ type: "chat.send", botId: BOT, text: "hi" });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    expect(realpathSync(lines(join(dir, "start.log")).at(-1).cwd)).toBe(repo);
  }, 90_000);
});
