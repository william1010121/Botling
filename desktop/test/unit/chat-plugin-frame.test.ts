// @vitest-environment jsdom
// The chat page as `botling.chat`'s web part, trusted by its FE-build hash (M7-07b; decision Q-M7-C5, plan-change C5, D56).
//   1. A card answer (a tool approval is one, `chat.answer`) is sent only while the chat plugin running is a pair of the FE-build manifest
//      (`approveRoute` says "direct" for its name and the hash the loader ran it under): chat-frame/card-answer.ts, called by ChatFrame.
//   2. The same kind of request from a framed third-party plugin (`ccb.requestApproval`, plugin-frame-host.ts) goes to the shell's
//      ApprovalSheet: nothing is sent until the user presses Allow, and then only the core's own values.
//   3. With the chat plugin's hash out of the manifest the loader refuses it (offered to a frame), the shell draws "Chat is unavailable."
//      (07a's line; 07c brings the fallback screen) and no answer is sent.
//   4. `botling.chat` provides `composer.insertQuote` (the `:chat` stand-in of renderer-kernel.ts is gone): plugin-kernel-quote.test.ts.
// The built renderer.js carrying the manifest text (the CSP blocks fetch, so the page reads `embeddedFeManifest()`) is checked by
// inpage-built-renderer.test.ts since 02c; the source checks at the end keep this card from reading it with `fetchFeManifest`.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { Command, PROTOCOL_VERSION, type BotView } from "../../src/contract";
import { useApprovalSheet } from "../../src/renderer/ApprovalSheet";
import { chatAnswerCommand, chatAnswerRoute, sendChatAnswer } from "../../src/renderer/chat-frame/card-answer";
import { CHAT_PLUGIN, CHAT_UNAVAILABLE } from "../../src/renderer/chat-names";
import { Client } from "../../src/renderer/client";
import { pluginFrameHost } from "../../src/renderer/plugin-frame-host";
import { rendererKernel } from "../../src/renderer/renderer-kernel";
import { approveRoute } from "../../src/renderer/shell/approve-route";
import { inPageHost, InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest, type FeManifest } from "../../src/renderer/shell/inpage-loader";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { desktop } from "../helpers";
import { drawPage, SITE, type Page } from "../main-slot-harness";

const full = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const shipped = full.plugins.find((entry) => entry.name === CHAT_PLUGIN)!;
const chatOnly: FeManifest = { plugins: [shipped] };
/** The manifest with the chat plugin's entry (its hash) taken out; the other plugins stay. */
const withoutChat: FeManifest = { plugins: full.plugins.filter((entry) => entry.name !== CHAT_PLUGIN) };
const BOT = "6A0B0000-0000-4000-8000-000000000070";
const MESSAGE = "6A0B0000-0000-4000-8000-000000000071";

const hosts: InPageHost[] = [];
const pages: Page[] = [];
function host(manifest: FeManifest) {
  const made = new InPageHost({ manifest, log: () => undefined });
  hosts.push(made);
  return made;
}
afterEach(async () => {
  for (const page of pages.splice(0)) await page.close();
  for (const one of hosts.splice(0)) await one.stop();
  reconcileView(null);
  await vi.waitFor(() => { expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent"); });
  vi.restoreAllMocks();
});

/** What the shell's `client.request` is: records every command, answers `answers[type]` (or nothing). */
function fakeClient(answers: Record<string, unknown> = {}) {
  const sent: { type: string; [key: string]: unknown }[] = [];
  const request = vi.fn(async (command: { type: string }) => { sent.push(command as never); return answers[command.type] ?? {}; });
  return { client: { request } as unknown as Pick<Client, "request">, sent, request };
}
const answer = (text = "Allow once") => chatAnswerCommand({ type: "answer", messageID: MESSAGE, text }, BOT)!;

describe("1. a card answer from the chat plugin, whose hash is trusted, is sent", () => {
  it("the loader runs botling.chat under the hash the build wrote, approveRoute says direct for that pair, and the answer goes to the core", async () => {
    const one = host(chatOnly);
    const [result] = await one.start();
    expect(result).toEqual({ status: "loaded", name: CHAT_PLUGIN, codeHash: shipped.codeHash });
    expect(one.loaded()).toEqual([{ name: CHAT_PLUGIN, codeHash: shipped.codeHash }]);
    // The list `approveRoute` asks is the one the loader trusts (the host's own, not the bundle's global one).
    expect(one.feManifest).toEqual(chatOnly);
    expect(approveRoute(one.loaded()[0], one.feManifest)).toBe("direct");
    expect(chatAnswerRoute(one)).toBe("direct");
    const { client, sent } = fakeClient();
    const errors: unknown[] = [];
    expect(sendChatAnswer(answer(), { client, onError: (failure) => errors.push(failure), host: one })).toBe("sent");
    expect(sent).toEqual([{ type: "chat.answer", botId: BOT, messageId: MESSAGE, text: "Allow once" }]);
    expect(Command.safeParse(sent[0]).success).toBe(true);
    expect(errors).toEqual([]);
  });

  it("a failed send reaches onError (as the page's other requests do), and is not sent a second time", async () => {
    const one = host(chatOnly);
    await one.start();
    const failure = new Error("core said no");
    const request = vi.fn(async () => { throw failure; });
    const errors: unknown[] = [];
    expect(sendChatAnswer(answer(), { client: { request } as never, onError: (each) => errors.push(each), host: one })).toBe("sent");
    await vi.waitFor(() => { expect(errors).toEqual([failure]); });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("the route is asked again at each answer (L-008): a plugin that runs under a hash the manifest does not list now is not trusted, whatever it was when it loaded", () => {
    const stale = { loaded: () => [{ name: CHAT_PLUGIN, codeHash: "f".repeat(64) }], unavailable: () => false, feManifest: chatOnly };
    expect(chatAnswerRoute(stale)).toBe("refused");
    const renamed = { loaded: () => [{ name: "acme.chat", codeHash: shipped.codeHash }, { name: CHAT_PLUGIN, codeHash: shipped.codeHash }], unavailable: () => false, feManifest: { plugins: [{ name: "acme.chat", codeHash: shipped.codeHash }] } };
    expect(chatAnswerRoute(renamed)).toBe("refused");
    const { client, request } = fakeClient();
    const errors: unknown[] = [];
    expect(sendChatAnswer(answer(), { client, onError: (failure) => errors.push(failure), host: stale })).toBe("refused");
    expect(request).not.toHaveBeenCalled();
    expect(errors.map(String)).toEqual([`Error: ${CHAT_UNAVAILABLE}`]);
  });

  it("fails closed when the host cannot answer (a check that throws refuses)", () => {
    const broken = { loaded: () => { throw new Error("no host"); }, unavailable: () => false, feManifest: chatOnly };
    expect(chatAnswerRoute(broken)).toBe("refused");
    const { client, request } = fakeClient();
    expect(sendChatAnswer(answer(), { client, onError: () => undefined, host: broken })).toBe("refused");
    expect(request).not.toHaveBeenCalled();
  });

  it("a page the shell never started a loader for (Botling Web 2.x, a test) sends as it always did: the host has said nothing about the plugin", () => {
    const never = { loaded: () => [], unavailable: () => false, feManifest: { plugins: [] } };
    expect(chatAnswerRoute(never)).toBe("direct");
  });
});

describe("chatAnswerCommand is what ChatFrame sent before the move", () => {
  it("a plain answer, pictures (cleaned, at most 10), a question group's picks (the text is then ignored)", () => {
    expect(chatAnswerCommand({ type: "answer", messageID: MESSAGE, text: "yes" }, BOT)).toEqual({ type: "chat.answer", botId: BOT, messageId: MESSAGE, text: "yes" });
    const images = Array.from({ length: 12 }, (_, index) => ({ name: index === 0 ? "" : `p${index}.png`, base64: "AAAA" }));
    const withImages = chatAnswerCommand({ type: "answer", messageID: MESSAGE, text: "", images: [...images, { name: 3, base64: "x" }, { name: "empty.png", base64: "" }] }, BOT)!;
    expect(withImages.images).toHaveLength(10);
    expect(withImages.images![0]).toEqual({ name: "picture.png", base64: "AAAA" });
    const picks = chatAnswerCommand({ type: "answer", messageID: MESSAGE, text: "ignored", picks: [{ options: [0, 12, 1], other: " ok " }] }, BOT)!; // a choices block carries up to 12 options (7bb8dc57), so 12 is the first index out of range
    expect(picks.picks).toEqual([{ options: [0, 1], other: " ok " }]);
    expect(Command.safeParse(picks).success).toBe(true);
  });

  it("nothing for a missing field, no chat, or an empty answer with no picture", () => {
    expect(chatAnswerCommand({ type: "answer", messageID: MESSAGE, text: "yes" }, null)).toBeNull();
    expect(chatAnswerCommand({ type: "answer", messageID: MESSAGE, text: "yes" }, undefined)).toBeNull();
    expect(chatAnswerCommand({ type: "answer", text: "yes" }, BOT)).toBeNull();
    expect(chatAnswerCommand({ type: "answer", messageID: MESSAGE }, BOT)).toBeNull();
    expect(chatAnswerCommand({ type: "answer", messageID: MESSAGE, text: "   " }, BOT)).toBeNull();
  });
});

describe("2. the same kind of request from a framed third-party plugin goes to the shell's approval sheet", () => {
  const view = { command: "npm test", folder: "/w/site", detail: null, card: "tests" };
  let root: ReturnType<typeof createRoot> | null = null;
  afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });

  it("nothing is sent for a framed fixture's ccb.requestApproval until Allow is pressed on the page's ApprovalSheet, and then only the core's values", async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const { client, sent } = fakeClient({ "plugins.approvalAsk": { needsApproval: view }, "plugins.approve": { accepted: true } });
    let sheet: ReturnType<typeof useApprovalSheet> | null = null;
    const Probe = () => { sheet = useApprovalSheet(client as unknown as Client, "en", () => undefined, 0); return sheet.sheet; };
    const element = document.createElement("div");
    document.body.append(element);
    root = createRoot(element);
    await act(async () => root!.render(createElement(Probe)));
    const frame = pluginFrameHost({ client: client as unknown as Client, components: () => ({}), bots: () => [{ id: BOT, role: "manager", name: "Site" } as BotView], ask: (...args) => sheet!.ask(...args) });
    // A framed plugin has no hash the loader trusts: its pair is not in the manifest, so approveRoute sends it to the sheet (06a's rule).
    expect(approveRoute({ name: "acme.frame", codeHash: shipped.codeHash }, full)).toBe("sheet");
    // The page asks the core what the command is (the frame's `command` text is not what the sheet shows).
    let outcome: unknown = "pending";
    await act(async () => { void frame.requestApproval!("acme.frame", { botId: BOT, command: "rm -rf /", folder: "/", card: "tests" }).then((value) => { outcome = value; }); await Promise.resolve(); });
    await vi.waitFor(() => { expect(element.querySelector(".approval-sheet")).not.toBeNull(); });
    expect(element.querySelector(".approval-command")?.textContent).toBe("npm test");
    expect(element.querySelector(".approval-folder")?.textContent).toBe("/w/site");
    expect(sent.map((command) => command.type)).toEqual(["plugins.approvalAsk"]);
    expect(outcome).toBe("pending");
    await act(async () => { element.querySelector<HTMLButtonElement>(".approval-allow")!.click(); });
    await vi.waitFor(() => { expect(outcome).toEqual({ allowed: true }); });
    expect(sent.at(-1)).toEqual({ type: "plugins.approve", name: "acme.frame", botId: BOT, command: "npm test", folder: "/w/site" });
    expect(sent.map((command) => command.type)).toEqual(["plugins.approvalAsk", "plugins.approve"]);
  });

  it("Cancel on the sheet sends no approve and the frame hears { allowed: false }", async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const { client, sent } = fakeClient({ "plugins.approvalAsk": { needsApproval: view } });
    let sheet: ReturnType<typeof useApprovalSheet> | null = null;
    const Probe = () => { sheet = useApprovalSheet(client as unknown as Client, "en", () => undefined, 0); return sheet.sheet; };
    const element = document.createElement("div");
    document.body.append(element);
    root = createRoot(element);
    await act(async () => root!.render(createElement(Probe)));
    const frame = pluginFrameHost({ client: client as unknown as Client, components: () => ({}), bots: () => [], ask: (...args) => sheet!.ask(...args) });
    let outcome: unknown = "pending";
    await act(async () => { void frame.requestApproval!("acme.frame", { botId: BOT, command: "x", folder: "/" }).then((value) => { outcome = value; }); await Promise.resolve(); });
    await vi.waitFor(() => { expect(element.querySelector(".approval-sheet")).not.toBeNull(); });
    await act(async () => { element.querySelector<HTMLButtonElement>(".dialog-cancel")!.click(); });
    await vi.waitFor(() => { expect(outcome).toEqual({ allowed: false }); });
    expect(sent.map((command) => command.type)).toEqual(["plugins.approvalAsk"]);
  });

  it("a framed plugin that names itself botling.chat, or runs the chat plugin's code under another hash, is still the sheet's; so is a hash with another name", () => {
    expect(approveRoute({ name: CHAT_PLUGIN, codeHash: "0".repeat(64) }, full)).toBe("sheet");
    expect(approveRoute({ name: "acme.chat", codeHash: shipped.codeHash }, full)).toBe("sheet");
    expect(approveRoute({ name: CHAT_PLUGIN, codeHash: shipped.codeHash }, full)).toBe("direct");
    expect(approveRoute({ name: CHAT_PLUGIN, codeHash: shipped.codeHash }, withoutChat)).toBe("sheet");
  });
});

describe("3. with the chat plugin's hash out of the manifest the loader refuses it and the shell says so", () => {
  /** The page reads the renderer's own `inPageHost`: let it see the test host instead (the page has no shell loader in a test). */
  const seenBy = (one: InPageHost) => vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => one.unavailable(name));

  it("the loader refuses botling.chat as not in the manifest and offers it to a frame; its answers are not sent", async () => {
    const one = host(withoutChat);
    const [result] = await one.start([{ name: CHAT_PLUGIN, codeHash: shipped.codeHash }]);
    expect(result).toEqual({ status: "refused", name: CHAT_PLUGIN, codeHash: shipped.codeHash, reason: "not-in-manifest", offered: true });
    expect(one.offered()).toEqual([{ name: CHAT_PLUGIN, codeHash: shipped.codeHash }]);
    expect(one.loaded()).toEqual([]);
    expect(one.unavailable(CHAT_PLUGIN)).toBe(true);
    expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent");
    expect(chatAnswerRoute(one)).toBe("refused");
    const { client, request } = fakeClient();
    const errors: unknown[] = [];
    expect(sendChatAnswer(answer(), { client, onError: (failure) => errors.push(failure), host: one })).toBe("refused");
    expect(request).not.toHaveBeenCalled();
    expect(errors.map(String)).toEqual([`Error: ${CHAT_UNAVAILABLE}`]);
  });

  it("a hash the build did not ship (the folder was edited) is refused the same way", async () => {
    const one = host(chatOnly);
    const [result] = await one.start([{ name: CHAT_PLUGIN, codeHash: "a".repeat(64) }]);
    expect(result).toMatchObject({ status: "refused", reason: "hash-changed", offered: true });
    expect(chatAnswerRoute(one)).toBe("refused");
  });

  it("the page draws the shell's \"Chat is unavailable.\" line and no chat frame, and the rest of the page stays", async () => {
    const one = host(withoutChat);
    seenBy(one);
    await one.start([{ name: CHAT_PLUGIN, codeHash: shipped.codeHash }]);
    const page = await drawPage({ shown: SITE });
    pages.push(page);
    await act(async () => { await vi.waitFor(() => { expect(page.host.querySelector(".chat-unavailable [role=status]")?.textContent).toBe(CHAT_UNAVAILABLE); }); });
    expect(page.host.querySelector("#chat-frame")).toBeNull();
    expect(page.host.querySelector("aside.rail")).not.toBeNull();
  });

  it("and with the plugin trusted the page draws the chat frame and no line", async () => {
    const one = host(chatOnly);
    seenBy(one);
    await one.start();
    const page = await drawPage({ shown: SITE });
    pages.push(page);
    await act(async () => { await vi.waitFor(() => { expect(page.host.querySelector("#chat-frame")).not.toBeNull(); }); });
    expect(page.host.querySelector(".chat-unavailable")).toBeNull();
  });
});

describe("the wiring and the sources", () => {
  const src = (file: string) => readFileSync(join(desktop, "src/renderer", file), "utf8");
  const code = (text: string) => text.replace(/\/\/.*$/gm, "");

  it("ChatFrame sends the card answer only through sendChatAnswer: no chat.answer request of its own", () => {
    const frame = code(src("chat-frame/ChatFrame.tsx"));
    expect(frame).toContain("chatAnswerCommand(action, chat?.botId)");
    expect(frame).toContain("sendChatAnswer(command, { client, onError })");
    expect(frame).not.toMatch(/type:\s*"chat\.answer"/);
  });

  it("the page's \"regather\" action is one chat.send to this chat's bot, replying to that line, paced, with empty words refused and a stopped message reported (not the feedback path)", () => {
    const frame = code(src("chat-frame/ChatFrame.tsx"));
    const start = frame.indexOf('case "regather"');
    const body = frame.slice(start, frame.indexOf("return;", frame.indexOf("onError);", start)));
    expect(start).toBeGreaterThan(0);
    expect(body).toContain('!action.text.trim()');
    expect(body).toContain('!paced("regather")');
    expect(body).toMatch(/type:\s*"chat\.send",\s*botId,\s*text:\s*action\.text\.slice\(0,\s*20_000\),\s*replyTo:\s*action\.messageID/);
    expect(body).toContain("result.stoppedBy");
    expect(body).toContain("onSent()");
    expect(body).not.toContain("chat.feedback");
  });

  it("only card-answer.ts builds a chat.answer, and the one approveRoute is 06a's (no second route function)", () => {
    const names: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) names.push(path);
      }
    };
    walk(join(desktop, "src/renderer"));
    const rel = (path: string) => path.slice(join(desktop, "src/renderer").length + 1);
    expect(names.filter((path) => /type:\s*"chat\.answer"/.test(code(readFileSync(path, "utf8")))).map(rel)).toEqual(["chat-frame/card-answer.ts"]);
    expect(names.filter((path) => /function\s+approveRoute\b/.test(readFileSync(path, "utf8"))).map(rel)).toEqual(["shell/approve-route.ts"]);
    expect(code(src("chat-frame/card-answer.ts"))).toContain('from "../shell/approve-route"');
  });

  it("the renderer reads the FE manifest the build embedded (the window's CSP blocks fetch): nothing in the card's files calls fetchFeManifest", () => {
    for (const file of ["chat-frame/card-answer.ts", "chat-frame/ChatFrame.tsx", "plugins/chat/index.ts", "composer-quote.ts", "shell/inpage-host.ts"]) {
      expect(code(src(file)), file).not.toContain("fetchFeManifest");
    }
    expect(code(src("shell/inpage-host.ts"))).toContain("embeddedFeManifest()");
  });

  it("the `:chat` stand-in is gone from renderer-kernel.ts and composer-quote.ts", () => {
    for (const file of ["renderer-kernel.ts", "composer-quote.ts"]) {
      const text = code(src(file));
      expect(text, file).not.toContain('":chat"');
      expect(text, file).not.toContain("CHAT_SURFACE");
    }
  });
});
