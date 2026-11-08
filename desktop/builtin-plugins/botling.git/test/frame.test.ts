// @vitest-environment jsdom
// The frame side: the shipped ui.js (the built bundle, on Preact) registers botling.git's two views (Worktrees block, settings page) and draws each from what the
// program part answers; the frame's calls become the requests the components make. There is no Review tab.
import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop } from "../../../test/helpers";
import { frameClient, RequestFailed } from "../src/client";

beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });
// out/ is built before the unit tests run (npm run build); esbuild itself cannot run inside jsdom.
const source = () => readFileSync(join(desktop, "out/builtin-plugins/botling.git/ui.js"), "utf8");

it("the frame's client turns commands into calls of the program part, a link into Botling's own command, and a failure into one with a sentence", async () => {
  const calls: unknown[][] = [], commands: string[][] = [];
  const ccb = { call: vi.fn(async (method: string, params?: unknown) => { calls.push([method, params]); if (method === "worktrees.merge") throw new Error("Nothing to merge."); return { ok: true }; }), command: (id: string, ...args: string[]) => { commands.push([id, ...args]); } };
  const client = frameClient(ccb);
  expect(await client.request({ type: "worktrees.create", botId: "B1", name: "x" })).toEqual({ ok: true });
  expect(calls).toEqual([["worktrees.create", { botId: "B1", name: "x" }]]);
  await client.request({ type: "link.open", source: "user", botId: "B1", url: "https://github.com/o/r/pull/1" } as never);
  expect(commands).toEqual([["botling.openLink", "B1", "https://github.com/o/r/pull/1"]]);
  expect(calls).toHaveLength(1);
  const failure = await client.request({ type: "worktrees.merge", botId: "B1", worktreeId: "w" }).catch((error) => error);
  expect(failure).toBeInstanceOf(RequestFailed);
  expect(failure.error.message).toBe("Nothing to merge.");
});

it("registers the Worktrees block and the settings page (no Review tab, no Review buttons) and draws them", async () => {
  const views = new Map<string, (root: HTMLElement) => (() => void) | void>();
  const commands: string[][] = [], calls: [string, any][] = [];
  const item = { id: "w1", branch: "bot/feat", path: "/w/feat", base: "main", task: null, owner: null, status: "active", createdAt: "2026-01-01T00:00:00Z", changedFiles: 2, ahead: 1, missing: false };
  const answers: Record<string, unknown> = {
    lang: "en",
    "worktrees.list": { enabled: true, available: true, current: "w1", root: "/r", items: [item] },
    "review.open": null,
    "review.target": { bot: { id: "B1", name: "Site" }, target: { worktreeId: "w1", branch: "bot/feat", base: "main", path: "/w/feat" }, stamp: 1 },
    "review.files": { ok: true, message: "", scope: "branch", from: "a".repeat(40), to: "b".repeat(40), base: "main", files: [{ path: "src/a.ts", status: "M", additions: 3, deletions: 1, binary: false }], additions: 3, deletions: 1, capped: false, turns: [], turn: null },
    "review.diff": { ok: true, message: "", path: "src/a.ts", binary: false, additions: 3, deletions: 1, tooLarge: false, truncated: false, hunks: [{ header: "@@ -1 +1,3 @@", lines: [{ t: "del", o: 1, text: "old" }, { t: "add", n: 1, text: "new" }] }] },
    settings: { enabled: true, root: "" },
  };
  const ccb = {
    context: { botId: "B1" },
    panels: { register: (id: string, fn: (root: HTMLElement) => void) => { views.set(id, fn); return () => {}; } },
    call: async (method: string, params?: unknown) => { calls.push([method, params]); return answers[method]; },
    command: (id: string, ...args: string[]) => { commands.push([id, ...args]); },
  };
  const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source()).toString("base64")}`);
  module.activate(ccb);
  expect([...views.keys()]).toEqual(["botling.git.worktrees", "botling.git.settings"]);

  const block = document.createElement("div"); document.body.append(block);
  const stop = views.get("botling.git.worktrees")!(block);
  await vi.waitFor(() => expect(block.textContent).toContain("bot/feat"));
  expect(calls.find(([method]) => method === "worktrees.list")![1]).toEqual({ botId: "B1" });
  expect(document.head.querySelector("style")?.textContent).toContain("--ground");
  expect(document.head.querySelector("style")?.textContent).toContain(".rv-file");
  expect(block.textContent).not.toContain("Review");
  expect(commands).toEqual([]);
  (stop as () => void)();

  const page = document.createElement("div"); document.body.append(page);
  views.get("botling.git.settings")!(page);
  await vi.waitFor(() => expect(page.querySelector('[aria-label="App-managed worktrees"]')).not.toBeNull());
});
