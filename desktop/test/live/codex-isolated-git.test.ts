// The isolated-Git approval gate end to end against the real `codex app-server`: a real worker
// thread asks for approval of its own Git commands, `CodexSession` (the same object `CodexHead`
// drives) answers them, and the commit must actually land. Codex's workspace-write sandbox keeps
// `.git` read-only, so this proves that an app "accept" is what lets the protected write happen.
// Opt-in: BOTLING_LIVE_CODEX_GIT=1. Runs in a throwaway /private/tmp repository with a throwaway
// CODEX_HOME (only a copy of auth.json); no push, no network writes besides the model calls.
// The coordinator's app_handoff call is injected (no coordinator turn), the worker is real.
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CodexSession, type CodexOutput } from "../../src/core/agent/codex";

const live = process.env.BOTLING_LIVE_CODEX_GIT === "1";
const cleanup: string[] = [];
let child: ChildProcessWithoutNullStreams | null = null;
afterAll(() => {
  child?.kill("SIGTERM");
  if (process.env.BOTLING_KEEP_LIVE_GIT !== "1") for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!live)("real codex app-server: isolated Git ownership", () => {
  it("auto-accepted worktree add / add / commit execute despite the read-only .git sandbox", async () => {
    // The gate refuses any GIT_* override in the app's own environment (e.g. a shell's GIT_EDITOR).
    for (const name of Object.keys(process.env)) if (/^GIT_/i.test(name) && name !== "GIT_PAGER") delete process.env[name];
    const root = mkdtempSync("/private/tmp/botling-2x-livegit-"); cleanup.push(root);
    const repo = join(root, "repo"), worktree = `${root}-worker`, codexHome = join(root, "codex-home");
    cleanup.push(worktree);
    mkdirSync(repo); mkdirSync(codexHome);
    copyFileSync(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"));
    git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Live Test"); git(repo, "config", "user.email", "live@example.invalid");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "own.txt"), "base\n"); writeFileSync(join(repo, "other.txt"), "base\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "base");
    const baseCommit = git(repo, "rev-parse", "HEAD");
    const ownership = { implementationAuthorized: true, repo, worktree, branch: "bot/live-owned", baseCommit, files: ["own.txt"] };

    const session = new CodexSession({ cwd: repo, instructions: "Coordinator", workerInstructions: "Execute the assigned task yourself and return concrete evidence. Do not delegate.", resumeThread: null, model: process.env.BOTLING_MODEL ?? null, workerModel: process.env.BOTLING_MODEL ?? null, effort: "low", restoredWorkers: [] });
    child = spawn(process.env.BOTLING_CODEX_PATH ?? "codex", ["app-server"], { cwd: repo, env: { ...process.env, CODEX_HOME: codexHome } });
    const injected = new Set<string>();
    const approvals: { command: unknown; cwd: unknown; answer: unknown }[] = [];
    const manualCards: { requestId: string; summary: string }[] = [];
    const log: string[] = [];
    const perform = (outputs: CodexOutput[]) => {
      for (const output of outputs) {
        if (output.kind === "write") {
          const value = output.value as any;
          if (value.id !== undefined && injected.has(String(value.id)) && !value.method) continue;
          if (value.result?.decision !== undefined) { const pending = approvals.find((a) => a.answer === undefined); if (pending) pending.answer = value.result.decision; }
          child!.stdin.write(`${JSON.stringify(value)}\n`);
        } else if (output.kind === "item" && output.item.kind === "permission") {
          manualCards.push({ requestId: output.item.requestId, summary: output.item.summary });
          // A person would decide here. Plain non-Git writes are allowed; Git is the gate's.
          const isGit = /\bgit\b/.test(output.item.summary);
          if (!isGit) perform(session.answer(output.item.requestId, true));
        }
      }
    };
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line);
          if (value.method === "item/commandExecution/requestApproval") approvals.push({ command: value.params.command, cwd: value.params.cwd, answer: undefined });
          if (value.method && /requestApproval|item\/completed/.test(value.method)) log.push(line.slice(0, 600));
        } catch { /* partial */ }
        perform(session.receive(line));
      }
    });
    let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (c: string) => { stderr = (stderr + c).slice(-4000); });
    perform(session.start());
    for (let i = 0; i < 300 && !session.threadId; i++) await sleep(100);
    expect(session.threadId, stderr).toBeTruthy();

    const steps = [
      `git worktree add -b ${ownership.branch} ${worktree} ${baseCommit}`,
      `printf 'changed by worker\\n' > ${worktree}/own.txt`,
      `git -C ${worktree} add -- own.txt`,
      `git -C ${worktree} commit -m "Live owned change"`,
    ];
    const instructions = `Run exactly these shell commands, one per tool call, in this order, from ${repo}. Do not use apply_patch and do not run anything else.${process.env.BOTLING_LIVE_GIT_HINT === "0" ? "" : " The commands that write Git metadata are blocked by the read-only .git sandbox, so request escalated sandbox permissions for every git command."}\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\nThen reply DONE.`;
    injected.add("inject-handoff");
    perform(session.receive(JSON.stringify({ id: "inject-handoff", method: "item/tool/call", params: { threadId: session.threadId, tool: "app_handoff", arguments: { instructions, name: "Live owned Git", isolated_git: ownership } } })));
    expect(session.workerRecords[0]?.isolatedGit).toEqual(ownership);

    let landed = "";
    for (let i = 0; i < 2400 && !landed; i++) {
      await sleep(100);
      try { landed = git(worktree, "log", "-1", "--format=%s", ownership.branch); if (landed !== "Live owned change") landed = ""; } catch { /* not yet */ }
    }
    console.log("approvals:", JSON.stringify(approvals, null, 1));
    console.log("manual cards:", JSON.stringify(manualCards, null, 1));
    console.log("protocol:", log.join("\n"));
    expect(landed, stderr).toBe("Live owned change");
    expect(git(worktree, "show", "--format=", "--name-only", "HEAD")).toBe("own.txt");
    expect(git(repo, "rev-parse", "main")).toBe(baseCommit);
    // Every Git approval was answered by the gate (accept), none became a manual card.
    expect(manualCards.filter((card) => /\bgit\b/.test(card.summary))).toEqual([]);
    expect(approvals.filter((a) => /\bgit\b/.test(String(a.command))).every((a) => a.answer === "accept")).toBe(true);
  }, 300_000);
});
