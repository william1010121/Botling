// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { Worktrees } from "../src/WorktreesView";
import { SettingsBlock } from "../src/views";
import { worktreeLine, worktreeWords } from "../src/worktree-text";
import type { Client } from "../src/client";

const item = { id: "w1", branch: "bot/feat", path: "/w/feat", base: "main", task: null, owner: null, status: "active" as const, createdAt: "2026-01-01T00:00:00Z", changedFiles: 2, ahead: 1, missing: false };
const bot = { id: "B1", role: "manager" } as any;
const hosts: HTMLElement[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });

async function mount(request: (cmd: any) => Promise<unknown>, lang: string | null = "en") {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Worktrees, { client: { request } as unknown as Client, bot, lang })));
  return { host, root, button: (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement | undefined };
}

it("words are English or Traditional Chinese, and a line says what git says", () => {
  expect(worktreeLine(item, worktreeWords("en"))).toBe("2 files changed · 1 commit ahead");
  expect(worktreeLine({ ...item, changedFiles: 0, ahead: 0 }, worktreeWords("en"))).toBe("No changes");
  expect(worktreeLine(item, worktreeWords("zh-Hant"))).toBe("2 個檔案有變更 · 領先 1 個提交");
  expect(worktreeWords("zh-Hant").loses(item)).toBe("捨棄會遺失 2 個未提交的檔案與 1 個未合併的提交。");
  expect(worktreeWords(null).merge("main")).toBe("Merge into main");
});

it("is not drawn when worktrees are off, or the project is not a git repository", async () => {
  for (const view of [{ enabled: false, available: false }, { enabled: true, available: false }]) {
    const { host, root } = await mount(async () => ({ ...view, current: null, root: "/r", items: [] }));
    expect(host.textContent).toBe("");
    await act(async () => root.unmount());
  }
});

it("lists active worktrees and drives New worktree, Merge, and a Discard that asks first", async () => {
  const calls: any[] = [];
  let items = [item];
  const request = async (cmd: any) => {
    calls.push(cmd);
    if (cmd.type === "worktrees.list") return { enabled: true, available: true, current: "w1", root: "/r", items };
    if (cmd.type === "worktrees.create") return { ok: true, message: "Made bot/new from main." };
    if (cmd.type === "worktrees.merge") return { ok: false, message: "The worktree has 2 uncommitted files. Commit them first (nothing was merged)." };
    if (cmd.type === "worktrees.discard") {
      if (!cmd.force) return { ok: false, confirm: true, message: "confirm" };
      items = []; return { ok: true, message: "Discarded the worktree and its branch." };
    }
    return { ok: true, message: "" };
  };
  const { host, button } = await mount(request);
  expect(host.textContent).toContain("bot/feat");
  expect(host.textContent).toContain("2 files changed · 1 commit ahead");
  expect(host.textContent).toContain("In use");

  await act(async () => button("New worktree")!.click());
  const input = host.querySelector<HTMLInputElement>(".worktree-input")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "New one"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => button("Create")!.click());
  expect(calls.find((c) => c.type === "worktrees.create")).toMatchObject({ botId: "B1", name: "New one" });
  expect(host.textContent).toContain("Made bot/new from main.");

  await act(async () => host.querySelector<HTMLButtonElement>(".task-row-open")!.click());
  for (const label of ["Use project folder", "Open in terminal", "Merge into main", "Discard"]) expect(button(label), label).toBeDefined();
  await act(async () => button("Merge into main")!.click());
  expect(host.querySelector(".worktree-note.bad")?.textContent).toContain("Commit them first");

  await act(async () => button("Discard")!.click());
  expect(host.textContent).toContain("Discarding loses 2 uncommitted files and 1 unmerged commit.");
  expect(calls.filter((c) => c.type === "worktrees.discard")).toHaveLength(1);
  await act(async () => button("Cancel")!.click());
  expect(calls.filter((c) => c.type === "worktrees.discard")).toHaveLength(1);
  await act(async () => button("Discard")!.click());
  await act(async () => button("Discard anyway")!.click());
  expect(calls.filter((c) => c.type === "worktrees.discard").at(-1)).toMatchObject({ worktreeId: "w1", force: true });
  expect(host.textContent).toContain("Discarded the worktree and its branch.");
  expect(host.querySelector(".worktree")).toBeNull();
});

it("shows Traditional Chinese labels", async () => {
  const { host } = await mount(async () => ({ enabled: true, available: true, current: null, root: "/r", items: [] }), "zh-Hant");
  expect(host.textContent).toContain("工作樹");
  expect(host.textContent).toContain("新增工作樹");
});

it("Settings → Worktrees has the toggle and the folder (the Developer page's two settings), saved through the program part", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host);
  const calls: any[] = [];
  const ccb = { call: async (method: string, params?: any) => {
    calls.push([method, params]);
    if (method === "lang") return "en";
    if (method === "settings") return { enabled: true, root: "" };
    if (method === "settings.set") return { enabled: params.enabled ?? true, root: params.root ?? "" };
    return null;
  }, command() {}, panels: { register: () => () => {} } };
  await act(async () => root.render(createElement(SettingsBlock, { ccb })));
  const toggle = host.querySelector<HTMLInputElement>('[aria-label="App-managed worktrees"]')!;
  expect(toggle.checked).toBe(true);
  await act(async () => toggle.click());
  expect(calls.filter(([method]) => method === "settings.set")).toEqual([["settings.set", { enabled: false }]]);
  expect(host.querySelector<HTMLInputElement>('[aria-label="Worktree folder"]')!.disabled).toBe(true);
  await act(async () => root.unmount());
});
