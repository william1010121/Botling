// /share in developer mode (1.x's CommunityShare.swift, Workspace+Share.swift): the developer
// project's chat lists your features, checks the one you pick, and opens its pull request.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { body, privacyFindings, ownerOfRemote } from "../../src/core/community-share";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null) await harness.kill("SIGKILL"); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

describe("/share", () => {
  it("reads forks and finds keys and home paths in what a feature adds", () => {
    expect(ownerOfRemote("git@github.com:me/Botling.git")).toBe("me");
    expect(ownerOfRemote("https://github.com/someone/Botling")).toBe("someone");
    expect(ownerOfRemote("https://gitlab.com/me/Botling.git")).toBeNull();
    const diff = "+++ b/a.ts\n+const key = \"sk-ant-abcdefghijklmnopqrstu\";\n+open(\"/Users/me/notes\")\n-gone\n+++ b/b.ts\n+fine";
    expect(privacyFindings(diff, "/Users/me")).toEqual(["a.ts: an Anthropic API key", "a.ts: your home folder's path"]);
    expect(body({ branch: "bot/x", title: "Faster", commits: 1, files: ["a.ts"], subjects: ["Faster"] })).toBe("Shared from Botling's developer mode with /share.\n\nCommits:\n- Faster\n\nFiles:\n- `a.ts`\n\nVote with 👍 on this pull request; the owner picks which community-features go into the next release.");
  });

  it("lists the developer project's features, checks the one you pick and opens its pull request; elsewhere it says what it needs", async () => {
    const dir = tempDir("share");
    const repo = join(tempDir("share-repo"), "Botling");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "."); git(repo, "commit", "-q", "-m", "Start");
    git(repo, "checkout", "-q", "-b", "bot/faster");
    writeFileSync(join(repo, "b.txt"), "two\n");
    git(repo, "add", "."); git(repo, "commit", "-q", "-m", "Make it faster");
    git(repo, "checkout", "-q", "main");
    git(repo, "remote", "add", "origin", "https://github.com/me/Botling.git");
    const log = join(dir, "share.log");
    const c = new CoreHarness(dir, { BOTLING_FAKE_SHARE_LOG: log });
    harnesses.push(c);
    const { botId } = await c.call({ type: "projects.add", folder: repo });
    // Not the developer project: the app says what /share needs, and the bot is not asked.
    expect(await c.call({ type: "chat.send", botId: MAIN, text: "/share" })).toMatchObject({ turnId: null });
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "notice" && m.text.startsWith("/share needs developer mode")));
    await c.call({ type: "settings.set", change: { key: "developerMode", value: true } });
    await c.call({ type: "settings.set", change: { key: "developerProject", value: botId } });
    expect(await c.call({ type: "chat.send", botId, text: "/share" })).toMatchObject({ turnId: null });
    const list = await until(async () => (await c.chat(botId)).messages.find((m: any) => m.text.startsWith("**Which feature do you want to share?**")));
    expect(list.choices.map((choice: any) => choice.label)).toEqual(["Make it faster", "Not now"]);
    expect(list.choices[0].detail).toBe("bot/faster · 1 commit · 1 file");
    await c.call({ type: "chat.choose", botId, messageId: list.id, index: 0 });
    const check = await until(async () => (await c.chat(botId)).messages.find((m: any) => m.text.startsWith("**Share \"Make it faster\"**")));
    expect(check.text).toContain("✓ Up to date with main\n✓ Privacy check: no keys, tokens or personal paths in the diff\n✓ Your fork: me/Botling\n✓ Description drafted from its 1 commit\n! Label: community-feature");
    expect(check.choices.map((choice: any) => choice.label)).toEqual(["Open pull request", "Not now"]);
    await c.call({ type: "chat.choose", botId, messageId: check.id, index: 0 });
    await until(async () => (await c.chat(botId)).messages.some((m: any) => m.text === "Opened a pull request for \"Make it faster\": https://github.com/william1010121/Botling/pull/1 Others vote on it with 👍."));
    const ran = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(ran[0]).toEqual(["git", "push", "-u", "origin", "bot/faster"]);
    expect(ran[1].slice(0, 9)).toEqual(["gh", "pr", "create", "--repo", "william1010121/Botling", "--base", "main", "--head", "me:bot/faster"]);
    expect(ran[1].slice(-2)).toEqual(["--label", "community-feature"]);
  });
});
