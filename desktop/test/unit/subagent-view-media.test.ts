// @vitest-environment jsdom
// A worker's (subagent's) own view shows its Read pictures and its reply's local pictures. Its chat
// state is named "<bot>/<subagent>", but the chat origin serves a file as one bot's: the page must ask
// for it as the bot that owns the worker. Regression: every picture in a worker's view came back
// "unavailable" (the origin's path never matched) while the main chat's pictures worked, and the
// tests only ever used a plain bot id.
//
// The page here is the production one (Web/src/main) with the same media source chat-frame/entry.ts
// installs, so the test survives moving the code between core, plugins and the chat page.
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SubagentView } from "../../src/contract";
import { subagentView } from "../../src/core/bot";
import { readSubagent, SubagentBook } from "../../src/core/subagents";
import { attachmentFile, attachmentTarget, localMediaSource } from "../../src/contract/attachment-url";
import { subagentState } from "../../src/renderer/payload";
import { setMediaSource } from "../../../Web/src/markdown";
import type { BotView } from "../../src/contract";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
// A sub bot's id and its worker's id, and a picture in the sub bot's own folder, as in the report.
const OWNER = "6A295F5C-B804-4197-916F-12111D602862";
const WORKER = "8967ee5c-51a6-44e0-a5e3-9a1541b2b29a";
const PICTURE = `/Users/me/docs/eeg/.bot/sub-bots/${OWNER}/artifacts/static/s1_embed_2a.png`;
const bot: BotView = { id: OWNER, name: "matt-spdim", role: "bot", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 1, problem: null, heads: ["claude"], job: null, subagentRows: [] };

/** What the chat origin (main.ts chatFile) makes of an <img> source: whose chat, and which file. */
const originSees = (src: string) => ({ target: attachmentTarget(new URL(src).pathname), file: attachmentFile(src, OWNER) });

describe("a worker's view asks the chat origin for pictures as the bot that owns the worker", () => {
  beforeAll(async () => {
    document.body.innerHTML = '<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>';
    await import("../../../Web/src/main");
  });

  it("the Read step's picture and the reply's inline picture reach the owner's attachment route", async () => {
    const record = readSubagent({
      id: WORKER, description: "Plot", prompt: "Plot the embedding", type: "general-purpose", status: "completed", background: true, startedAt: 0, endedAt: 9,
      result: `Done: ![embed](file://${PICTURE})`,
      steps: [{ id: `${WORKER}:1:toolu_1`, kind: "tool", tool: "Read", title: "Read s1_embed_2a.png", detail: PICTURE, done: true, failed: false, output: "" }],
    })!;
    const state = subagentState(bot, SubagentView.parse(subagentView(record, bot.name, new SubagentBook([record])))).state;
    expect(state.botID).toBe(`${OWNER}/${WORKER}`);
    // What chat-frame/entry.ts does with a state before the page draws it.
    setMediaSource((url) => localMediaSource(state.botID, url));
    window.ccb.setState(state);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const inline = document.querySelector<HTMLImageElement>(".sub-text img.media");
    expect(inline, "the reply's inline picture is drawn").toBeTruthy();
    expect(originSees(inline!.src).target).toEqual({ botId: OWNER, ref: `file://${PICTURE}` });

    document.querySelector<HTMLButtonElement>(".steps-toggle")!.click(); // "1 step" opens the fold
    document.querySelector<HTMLButtonElement>(".step.tool .step-head")!.click();
    const image = document.querySelector<HTMLImageElement>("img.step-image");
    expect(image, "the opened Read step draws its picture").toBeTruthy();
    const seen = originSees(image!.src);
    // The step names a path, made a file URL as the platform makes one (Windows puts the current drive in front).
    const ref = pathToFileURL(PICTURE).href;
    expect(seen.target).toEqual({ botId: OWNER, ref });
    expect(seen.file).toBe(ref);
  });

  it("localMediaSource names the owner, for a worker's composite chat id and for a plain one", () => {
    for (const shown of [OWNER, `${OWNER}/${WORKER}`]) {
      expect(attachmentTarget(new URL(localMediaSource(shown, `file://${PICTURE}`)).pathname)).toEqual({ botId: OWNER, ref: `file://${PICTURE}` });
      expect(attachmentTarget(new URL(localMediaSource(shown, PICTURE)).pathname)?.botId).toBe(OWNER);
    }
  });
});
