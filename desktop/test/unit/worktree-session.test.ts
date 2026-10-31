// App-managed worktrees through the real core process (fake agent, no windows): the session starts in the
// current worktree, keeps the project's .bot reachable, hears about it, and is back in the project folder
// once the worktree is discarded; discarding asks first when work would be lost.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir, until } from "../helpers";
import { CoreHarness } from "../core-harness";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null) await harness.kill("SIGTERM"); });
const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const BOT = "6A0B0000-0000-4000-8000-0000000000AA";

describe("worktrees in the core", () => {
  it("starts the session in the current worktree, then back in the project folder after a discard", async () => {
    const dir = tempDir("wt-session");
    const repo = realpathSync(mkdirSync(join(dir, "repo"), { recursive: true }) ?? join(dir, "repo"));
    git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "T"); git(repo, "config", "user.email", "t@example.invalid");
    writeFileSync(join(repo, "a.txt"), "a"); git(repo, "add", "."); git(repo, "commit", "-m", "a");
    writeFileSync(join(dir, "projects.json"), JSON.stringify([{ id: BOT, name: "Proj", folder: pathToFileURL(repo).href + "/", avatar: "hexagon" }]));
    const c = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir, "start.log"), FAKE_CLAUDE_INPUT: join(dir, "input.log") });
    harnesses.push(c);
    const root = join(dir, "wt-root");
    await c.call({ type: "settings.set", change: { key: "worktreeRoot", value: root } });
    const send = async (text: string) => { const sent = await c.call({ type: "chat.send", botId: BOT, text }); await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId)); };

    expect(await c.call({ type: "worktrees.list", botId: BOT })).toMatchObject({ enabled: true, available: true, current: null, items: [] });
    await send("hello");
    expect(realpathSync(lines(join(dir, "start.log")).at(-1).cwd)).toBe(repo);

    expect(await c.call({ type: "worktrees.create", botId: BOT, name: "Try it" })).toMatchObject({ ok: true });
    const listed = await c.call({ type: "worktrees.list", botId: BOT });
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
    const review = await c.call({ type: "review.files", botId: BOT, worktreeId: tree.id, scope: "branch" });
    expect(review).toMatchObject({ ok: true, base: "main" });
    expect(review.files.map((f: any) => f.path)).toEqual(["review-me.txt"]);
    await until(async () => (await c.call({ type: "review.files", botId: BOT, worktreeId: tree.id, scope: "branch" })).turns.length >= 1);
    const turn = (await c.call({ type: "review.files", botId: BOT, worktreeId: tree.id, scope: "branch" })).turns[0];
    expect((await c.call({ type: "review.files", botId: BOT, worktreeId: tree.id, scope: "turn", turn: turn.id })).files.map((f: any) => f.path)).toEqual(["review-me.txt"]);
    expect(await c.call({ type: "review.diff", botId: BOT, worktreeId: null, from: "", to: review.to, path: "../x" })).toMatchObject({ ok: false });

    // Work that would be lost needs a confirmation; then the session is back in the project folder.
    writeFileSync(join(tree.path, "wip.txt"), "wip");
    expect(await c.call({ type: "worktrees.discard", botId: BOT, worktreeId: tree.id })).toMatchObject({ ok: false, confirm: true });
    expect(existsSync(join(tree.path, "wip.txt"))).toBe(true);
    expect(await c.call({ type: "worktrees.discard", botId: BOT, worktreeId: tree.id, force: true })).toMatchObject({ ok: true });
    await send("back");
    expect(realpathSync(lines(join(dir, "start.log")).at(-1).cwd)).toBe(repo);
    expect(git(repo, "branch", "--list", "bot/try-it")).toBe("");
  });

  it("with the setting off, nothing is listed or made and the session stays in the project folder", async () => {
    const dir = tempDir("wt-off");
    const repo = realpathSync(mkdirSync(join(dir, "repo"), { recursive: true }) ?? join(dir, "repo"));
    git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "T"); git(repo, "config", "user.email", "t@example.invalid");
    writeFileSync(join(repo, "a.txt"), "a"); git(repo, "add", "."); git(repo, "commit", "-m", "a");
    writeFileSync(join(dir, "projects.json"), JSON.stringify([{ id: BOT, name: "Proj", folder: pathToFileURL(repo).href + "/", avatar: "hexagon" }]));
    const c = new CoreHarness(dir, {});
    harnesses.push(c);
    await c.call({ type: "settings.set", change: { key: "worktrees", value: false } });
    expect(await c.call({ type: "worktrees.list", botId: BOT })).toMatchObject({ enabled: false, available: false, items: [] });
    expect(await c.call({ type: "worktrees.create", botId: BOT, name: "x" })).toMatchObject({ ok: false });
  });
});
