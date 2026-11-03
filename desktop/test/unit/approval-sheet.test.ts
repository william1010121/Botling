// @vitest-environment jsdom
// A card's command is allowed only on the app page's ApprovalSheet (plugin-platform.md §5.4, G2): a chat page action
// carrying approve asks only to run; what the core answers (needsApproval) opens the sheet, whose Allow sends
// component.approve / pin.approve / spec.approve with the core's values; nothing in a frame's routing can send those.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Command, PROTOCOL_VERSION, RENDERER_COMMANDS, type ApprovalAskView } from "../../src/contract";
import { Client } from "../../src/renderer/client";
import { asksUser, cardApprove, cardRun } from "../../src/renderer/card-approval";
import { ApprovalSheet, useApprovalSheet } from "../../src/renderer/ApprovalSheet";

const BOT = "6A0B0000-0000-4000-8000-000000000002";
const MESSAGE = "6A0B0000-0000-4000-8000-000000000010";
const PIN = "6A0B0000-0000-4000-8000-000000000011";
const ask: ApprovalAskView = { command: "git log --oneline", folder: "/p/garden", detail: "git show {hash}", card: "commits" };

describe("chat page actions only ask to run", () => {
  it("drops approve from componentCommand and pinCommand; what is sent is a valid command without it", () => {
    const runs = [
      cardRun({ type: "componentCommand", messageID: MESSAGE, index: 0, command: "git log", folder: "/p", detail: "git show {hash}", approve: true, force: true }, BOT),
      cardRun({ type: "pinCommand", id: PIN, command: "git log", folder: "/p", approve: true }, BOT),
    ];
    expect(runs).toEqual([
      { type: "component.command", botId: BOT, messageId: MESSAGE, index: 0, command: "git log", folder: "/p", detail: "git show {hash}", force: true },
      { type: "pin.command", botId: BOT, id: PIN, command: "git log", folder: "/p" },
    ]);
    for (const run of runs) expect(Command.safeParse(run).success).toBe(true);
    expect(JSON.stringify(runs)).not.toContain("approve");
    // Missing fields or no chat: nothing.
    expect(cardRun({ type: "componentCommand", messageID: MESSAGE, index: 0, command: "git log", folder: "/p" }, null)).toBeNull();
    expect(cardRun({ type: "pinCommand", approve: true }, BOT)).toBeNull();
    expect(cardRun({ type: "componentApprove", messageID: MESSAGE, index: 0, command: "git log", folder: "/p" }, BOT)).toBeNull();
  });

  it("the contract has no approve on a run, and the approve commands are app-page commands", () => {
    expect(Command.safeParse({ type: "component.command", botId: BOT, messageId: MESSAGE, index: 0, command: "x", folder: "/p", approve: true }).success).toBe(false);
    expect(Command.safeParse({ type: "pin.command", botId: BOT, id: PIN, approve: true }).success).toBe(false);
    for (const type of ["component.approve", "pin.approve"] as const) expect(RENDERER_COMMANDS.has(type)).toBe(true);
  });

  it("the sheet's Allow sends the core's command, folder and Detail command, not the page's", () => {
    const run = cardRun({ type: "componentCommand", messageID: MESSAGE, index: 1, command: "echo page", folder: "/elsewhere" }, BOT)!;
    expect(cardApprove(run, ask)).toEqual({ type: "component.approve", botId: BOT, messageId: MESSAGE, index: 1, command: "git log --oneline", folder: "/p/garden", detail: "git show {hash}" });
    expect(cardApprove(cardRun({ type: "pinCommand", id: PIN }, BOT)!, { ...ask, detail: null })).toEqual({ type: "pin.approve", botId: BOT, id: PIN, command: "git log --oneline", folder: "/p/garden" });
    for (const approve of [cardApprove(run, ask), cardApprove(cardRun({ type: "pinCommand", id: PIN }, BOT)!, ask)]) expect(Command.safeParse(approve).success).toBe(true);
    // A card's or a floating pin's own timer never opens the sheet.
    expect(asksUser({ type: "componentCommand", messageID: MESSAGE, index: 0, command: "x", folder: "/p", force: true, live: true })).toBe(false);
    expect(asksUser({ type: "pinCommand", id: PIN, command: "x", folder: "/p", force: true, live: true })).toBe(false);
    expect(asksUser({ type: "pinCommand", id: PIN, command: "x", folder: "/p" })).toBe(true);
  });

  it("no chat page, card frame or frame routing names the approve commands: only the app page's sheet sends them", () => {
    const root = join(__dirname, "../..");
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
    const naming = [...files(join(root, "src/renderer")), ...files(join(root, "src/main")), ...files(join(root, "../Web/src")), ...files(join(root, "../Web/host/src"))]
      .filter((file) => /"(component|pin|spec)\.approve"/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(join(root, "..").length + 1)).sort();
    expect(naming).toEqual(["desktop/src/renderer/card-approval.ts"]);
  });
});

describe("ApprovalSheet", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });

  it("shows the command, folder and Detail command in full; Allow waits a moment, then allows; Cancel and Escape cancel", async () => {
    const calls: string[] = [];
    await act(async () => root.render(createElement(ApprovalSheet, { ask, lang: "en", armMs: 40, onAllow: () => calls.push("allow"), onCancel: () => calls.push("cancel") })));
    const sheet = document.querySelector(".approval-sheet")!;
    expect(sheet.getAttribute("role")).toBe("alertdialog");
    expect(sheet.querySelector("h2")?.textContent).toBe("Allow this command to run?");
    expect(sheet.querySelector("#approval-line")?.textContent).toBe("“commits” gets its data by running this command in");
    expect(sheet.querySelector(".approval-folder")?.textContent).toBe("/p/garden");
    expect([...sheet.querySelectorAll(".approval-command")].map((pre) => pre.textContent)).toEqual(["git log --oneline", "git show {hash}"]);
    expect(document.activeElement?.className).toBe("dialog-cancel");
    const allow = sheet.querySelector<HTMLButtonElement>(".approval-allow")!;
    expect(allow.disabled).toBe(true);
    await act(async () => allow.click());
    expect(calls).toEqual([]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    expect(allow.disabled).toBe(false);
    await act(async () => allow.click());
    await act(async () => sheet.querySelector<HTMLButtonElement>(".dialog-cancel")!.click());
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(calls).toEqual(["allow", "cancel", "cancel"]);
  });

  it("speaks Traditional Chinese; no Detail command, no Detail line", async () => {
    await act(async () => root.render(createElement(ApprovalSheet, { ask: { ...ask, detail: null }, lang: "zh-Hant", armMs: 0, onAllow: () => {}, onCancel: () => {} })));
    const sheet = document.querySelector(".approval-sheet")!;
    expect(sheet.querySelector("h2")?.textContent).toBe("允許執行這個指令嗎？");
    expect(sheet.querySelector("#approval-line")?.textContent).toBe("「commits」的資料來自執行這個指令，執行位置：");
    expect(sheet.querySelector(".approval-allow")?.textContent).toBe("允許並執行");
    expect(sheet.querySelector(".dialog-cancel")?.textContent).toBe("取消");
    expect(sheet.querySelectorAll(".approval-command")).toHaveLength(1);
    expect(sheet.querySelector(".approval-detail-line")).toBeNull();
  });

  it("one sheet at a time: a second ask while one is open is ignored; Allow sends the approve command once", async () => {
    const sent: any[] = [];
    let receive: (value: unknown) => void = () => {};
    const client = new Client({ protocol: PROTOCOL_VERSION, subscribe(listener) { receive = listener; return () => {}; }, post(envelope: any) {
      sent.push(envelope.cmd);
      queueMicrotask(() => receive({ v: PROTOCOL_VERSION, id: envelope.id, ok: true, result: { accepted: true } }));
    } });
    let opener: ReturnType<typeof useApprovalSheet>["ask"] = () => {};
    function Page() {
      const approval = useApprovalSheet(client, "en", () => {}, 0);
      opener = approval.ask;
      return createElement("div", null, approval.sheet);
    }
    await act(async () => root.render(createElement(Page)));
    expect(document.querySelector(".approval-sheet")).toBeNull();
    const first = { type: "pin.approve", botId: BOT, id: PIN, command: ask.command, folder: ask.folder } as const;
    await act(async () => opener({ ...ask, detail: null }, first));
    await act(async () => opener({ command: "rm -rf ~", folder: "/", detail: null, card: "other" }, { type: "pin.approve", botId: BOT, id: PIN, command: "rm -rf ~", folder: "/" }));
    expect(document.querySelector(".approval-command")?.textContent).toBe("git log --oneline");
    await act(async () => document.querySelector<HTMLButtonElement>(".approval-allow")!.click());
    expect(sent).toEqual([first]);
    expect(document.querySelector(".approval-sheet")).toBeNull();
  });
});
