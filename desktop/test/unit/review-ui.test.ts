// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { Review, splitRows } from "../../src/renderer/Review";
import { Worktrees } from "../../src/renderer/Worktrees";
import { languageOf, tokenize } from "../../src/renderer/highlight";
import { formatReviewComments } from "../../src/renderer/review-comments";
import { reviewWords } from "../../src/renderer/review-text";
import type { Client } from "../../src/renderer/client";

const hosts: HTMLElement[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });
const bot = { id: "B1", name: "Proj", role: "manager" } as any;
const target = { worktreeId: "w1", branch: "bot/feat", base: "main", path: "/w/feat" };

const filesView = (extra: object = {}) => ({
  ok: true, message: "", scope: "branch", from: "a".repeat(40), to: "b".repeat(40), base: "main",
  files: [
    { path: "src/a.ts", status: "M", additions: 1, deletions: 1, binary: false },
    { path: "src/new.ts", status: "A", additions: 2, deletions: 0, binary: false },
    { path: "img.png", status: "M", additions: 0, deletions: 0, binary: true },
  ],
  additions: 3, deletions: 1, capped: false, turns: [{ id: "t1", at: "2026-01-01T10:00:00Z" }, { id: "t2", at: "2026-01-01T11:00:00Z" }], turn: null, ...extra,
});
const diffView = (path: string, extra: object = {}) => ({
  ok: true, message: "", path, binary: false, additions: 1, deletions: 1, tooLarge: false, truncated: false,
  hunks: [{ header: "@@ -1,3 +1,3 @@", lines: [
    { t: "ctx", o: 1, n: 1, text: "const a = 1;" }, { t: "del", o: 2, text: "const b = 2; // old" }, { t: "add", n: 2, text: "const b = \"two\";" }, { t: "ctx", o: 3, n: 3, text: "export {};" },
  ] }], ...extra,
});

async function mount(request: (cmd: any) => Promise<unknown>, lang: string | null = "en", props: object = {}) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const root = createRoot(host);
  const closed: number[] = [];
  await act(async () => root.render(createElement(Review, { client: { request } as unknown as Client, bot, target, lang, onClose: () => closed.push(1), ...props })));
  const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
  return { host, root, closed, button };
}

it("tokenizes a line without losing any of it, and leaves unknown files plain", () => {
  for (const [line, lang] of [['const s = "a\\"b"; // note', "js"], ["x = 0x1F + 2.5e3  # c", "py"], ["/* start", "js"], ["plain text", null], ['{"a": [1, true, null]}', "json"], ["let unterminated = 'abc", "js"]] as const) {
    expect(tokenize(line, lang).map((t) => t.text).join("")).toBe(line);
  }
  expect(tokenize('const s = "x"; // hi', "js").filter((t) => t.kind).map((t) => [t.kind, t.text])).toEqual([["kw", "const"], ["str", '"x"'], ["com", "// hi"]]);
  expect(tokenize("n = 42 # c", "py").filter((t) => t.kind).map((t) => t.kind)).toEqual(["num", "com"]);
  expect(tokenize("a1 = b2", "py").some((t) => t.kind === "num")).toBe(false);
  expect(tokenize("whatever", null)).toEqual([{ text: "whatever", kind: "" }]);
  expect(languageOf("src/x.tsx")).toBe("js");
  expect(languageOf("a/b/main.rs")).toBe("rust");
  expect(languageOf("README.md")).toBeNull();
  expect(languageOf("noext")).toBeNull();
});

it("pairs deleted and added lines for the split view", () => {
  const rows = splitRows(diffView("x").hunks[0].lines as any);
  expect(rows.map((r) => [r.left?.t ?? null, r.right?.t ?? null])).toEqual([["ctx", "ctx"], ["del", "add"], ["ctx", "ctx"]]);
  const uneven = splitRows([{ t: "del", o: 1, text: "a" }, { t: "del", o: 2, text: "b" }, { t: "add", n: 1, text: "c" }] as any);
  expect(uneven.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([["a", "c"], ["b", null]]);
});

it("writes the comments as one message: place, quoted code, comment", () => {
  const text = formatReviewComments({ branch: "bot/feat", base: "main", path: "/w/feat" }, [
    { id: "1", path: "src/a.ts", line: 2, side: "new", code: "const b = \"two\";", text: "Why a string?" },
    { id: "2", path: "src/a.ts", line: 2, side: "old", code: "const b = 2;\nsecond line ignored", text: "Keep this\nas a number." },
  ]);
  expect(text).toBe([
    "Review comments on worktree bot/feat (compared with main) at /w/feat. 2 comments; please address each in the code in that worktree.",
    "1. src/a.ts:2\n   > const b = \"two\";\n   Why a string?",
    "2. src/a.ts:2 (the line before the change, now removed)\n   > const b = 2;\n   Keep this\n   as a number.",
  ].join("\n\n"));
  expect(formatReviewComments({ branch: null, base: null, path: null }, [{ id: "1", path: "a", line: 1, side: "new", code: "x", text: "t" }]))
    .toMatch(/^Review comments on the project's working tree\. One comment; please address it in the code\.\n\n1\. a:1\n   > x\n   t$/);
});

it("lists the files, loads the first file's diff, and shows binary and large files as such", async () => {
  const calls: any[] = [];
  const request = async (cmd: any) => {
    calls.push(cmd);
    if (cmd.type === "review.files") return filesView();
    if (cmd.path === "src/a.ts") return diffView("src/a.ts");
    if (cmd.path === "img.png") return diffView("img.png", { binary: true, hunks: [] });
    if (cmd.path === "src/new.ts") return cmd.force ? diffView("src/new.ts") : diffView("src/new.ts", { tooLarge: true, additions: 5000, deletions: 0, hunks: [] });
    return { ok: true };
  };
  const { host } = await mount(request);
  expect(calls[0]).toEqual({ type: "review.files", botId: "B1", worktreeId: "w1", scope: "branch" });
  expect(host.textContent).toContain("3 files · +3 −1");
  expect(host.querySelector(".rv-name")!.textContent).toBe("src/a.ts");
  expect(calls[1]).toMatchObject({ type: "review.diff", worktreeId: "w1", from: "a".repeat(40), to: "b".repeat(40), path: "src/a.ts" });
  expect(host.querySelectorAll(".rv-code.add")).toHaveLength(1);
  expect(host.querySelector(".tk-kw")!.textContent).toBe("const");
  expect(host.querySelector(".rv-code.del .tk-com")!.textContent).toBe("// old");

  const files = [...host.querySelectorAll<HTMLButtonElement>(".rv-file")];
  await act(async () => files[2].click());
  expect(host.textContent).toContain("Binary file; no text to show.");
  await act(async () => files[1].click());
  expect(host.textContent).toContain("This file changed 5000 lines");
  expect(calls.filter((c) => c.type === "review.diff" && c.path === "src/new.ts")).toHaveLength(1);
  await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Show anyway")!.click());
  expect(calls.at(-1)).toMatchObject({ path: "src/new.ts", force: true });
  expect(host.textContent).not.toContain("showing it can be slow");
  // Going back to a file already read does not ask again.
  const before = calls.length;
  await act(async () => files[0].click());
  expect(calls.length).toBe(before);
});

it("adds a comment by clicking a line, and sends every comment to the owning bot as one message", async () => {
  const calls: any[] = [];
  const request = async (cmd: any) => {
    calls.push(cmd);
    if (cmd.type === "review.files") return filesView();
    if (cmd.type === "review.diff") return diffView(cmd.path);
    if (cmd.type === "chat.send") return { messageId: "m", turnId: null };
    return {};
  };
  const { host, button } = await mount(request);
  expect(button("Send to agent")).toBeUndefined();
  const addButtons = () => [...host.querySelectorAll<HTMLButtonElement>(".rv-add")];
  // Click the new-side line 2 (the added line): the editor opens under it.
  await act(async () => addButtons()[2].click());
  const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(button("Add comment")!.disabled).toBe(true);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(area, "Keep this a number."); area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Add comment")!.click());
  expect(host.querySelector(".rv-comment-text")!.textContent).toBe("Keep this a number.");
  expect(host.textContent).toContain("1 comment ready");
  expect(host.querySelector(".rv-file .task-summary-tag")!.textContent).toBe("1");

  // A comment on the deleted line is about the old file's line.
  await act(async () => addButtons()[1].click());
  await act(async () => {
    const next = host.querySelector<HTMLTextAreaElement>("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(next, "Why remove?"); next.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Add comment")!.click());
  expect(host.textContent).toContain("2 comments ready");

  await act(async () => button("Send to agent")!.click());
  const sent = calls.find((c) => c.type === "chat.send");
  expect(sent).toMatchObject({ botId: "B1" });
  expect(sent.text).toContain("bot/feat (compared with main) at /w/feat");
  expect(sent.text).toContain("1. src/a.ts:2\n   > const b = \"two\";\n   Keep this a number.");
  expect(sent.text).toContain("2. src/a.ts:2 (the line before the change, now removed)\n   > const b = 2; // old\n   Why remove?");
  expect(host.textContent).toContain("Sent to Proj.");
  expect(host.querySelector(".rv-comment")).toBeNull();
  expect(button("Send to agent")).toBeUndefined();
});

it("keeps the comments when sending fails, and says why", async () => {
  const request = async (cmd: any) => {
    if (cmd.type === "review.files") return filesView();
    if (cmd.type === "review.diff") return diffView(cmd.path);
    throw new Error("Bot is asleep");
  };
  const { host, button } = await mount(request);
  await act(async () => host.querySelectorAll<HTMLButtonElement>(".rv-add")[0].click());
  await act(async () => {
    const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "x"); area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Add comment")!.click());
  await act(async () => button("Send to agent")!.click());
  expect(host.textContent).toContain("Could not send the comments.");
  expect(host.textContent).toContain("1 comment ready");
});

it("switches to split view and to one turn, and closes", async () => {
  const calls: any[] = [];
  const request = async (cmd: any) => {
    calls.push(cmd);
    if (cmd.type === "review.files") return filesView({ scope: cmd.scope, turn: cmd.turn ?? null });
    return diffView(cmd.path);
  };
  const { host, button, closed } = await mount(request);
  await act(async () => button("Split")!.click());
  expect(host.querySelector(".rv-table")!.classList.contains("split")).toBe(true);
  expect(localStorage.getItem("botling.review.split")).toBe("1");
  await act(async () => button("Unified")!.click());
  expect(host.querySelector(".rv-table")!.classList.contains("split")).toBe(false);

  await act(async () => button("Uncommitted")!.click());
  expect(calls.filter((c) => c.type === "review.files").at(-1)).toMatchObject({ scope: "uncommitted" });
  await act(async () => button("One turn")!.click());
  await act(async () => {});
  expect(calls.filter((c) => c.type === "review.files").at(-1)).toMatchObject({ scope: "turn", turn: "t2" });
  expect(host.querySelector("select")!.querySelectorAll("option")).toHaveLength(2);
  await act(async () => button("Close")!.click());
  expect(closed).toHaveLength(1);
});

it("shows a refusal as it is, and the main checkout has no scope switch", async () => {
  const { host } = await mount(async (cmd: any) => ({ ...filesView({ files: [] }), ok: false, message: "That worktree is not there." }), "en", { target: { worktreeId: null, branch: null, base: null, path: null } });
  expect(host.textContent).toContain("That worktree is not there.");
  expect(host.textContent).toContain("Review · working tree");
  expect(host.textContent).not.toContain("One turn");
});

it("is in Traditional Chinese for zh-Hant", async () => {
  const { host } = await mount(async (cmd: any) => (cmd.type === "review.files" ? filesView() : diffView(cmd.path)), "zh-Hant");
  expect(host.textContent).toContain("檢視 · bot/feat");
  expect(host.textContent).toContain("相對於 main");
  expect(host.textContent).toContain("3 個檔案 · +3 −1");
  expect(reviewWords("zh-Hant").pending(2)).toBe("2 則留言待送出");
  expect(reviewWords("en").status.R).toBe("Renamed");
});

it("the Worktrees control opens the review of a worktree or of the working tree", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); hosts.push(host);
  const item = { id: "w1", branch: "bot/feat", path: "/w/feat", base: "main", task: null, owner: null, status: "active", createdAt: "2026-01-01T00:00:00Z", changedFiles: 0, ahead: 1, missing: false };
  const request = async () => ({ enabled: true, available: true, current: null, root: "/r", items: [item] });
  const opened: any[] = [];
  await act(async () => createRoot(host).render(createElement(Worktrees, { client: { request } as unknown as Client, bot, lang: "en", onReview: (t: any) => opened.push(t) })));
  const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;
  await act(async () => button("Review changes").click());
  expect(opened.at(-1)).toEqual({ worktreeId: null, branch: null, base: null, path: null });
  await act(async () => (host.querySelector(".task-row-open") as HTMLButtonElement).click());
  await act(async () => button("Review").click());
  expect(opened.at(-1)).toEqual({ worktreeId: "w1", branch: "bot/feat", base: "main", path: "/w/feat" });
});
