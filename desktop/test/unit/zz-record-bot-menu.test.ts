// @vitest-environment jsdom
// TEMPORARY (M7-05b): records the bot menu's markup from the old code. Prints each golden between markers; removed in the next commit.
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, vi } from "vitest";
import { BotMenu } from "../../src/renderer/Rail";
import type { BotView } from "../../src/contract";
import { ID, mountPage, NOW, pluginsWithMenus } from "../sidebar-page";

const bot = (role: string): BotView => ({ id: "p1", name: "botling", role, avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] } as unknown as BotView);
const commands = [{ command: "zed.tools.run", title: "Run zed" }, { command: "acme.sync", title: "Sync <acme> & co" }];
const base = { at: { x: 12, y: 34 }, onRemove() {}, onClose() {}, onTogglePin() {}, onRestart() {} };
const out = (name: string, html: string) => console.log(`<<<GOLDEN ${name}>>>\n${html}\n<<<END>>>`);

describe("record", () => {
  it("static", () => {
    out("bot", renderToStaticMarkup(createElement(BotMenu, { ...base, bot: bot("bot"), pinned: false })));
    out("pinned", renderToStaticMarkup(createElement(BotMenu, { ...base, bot: bot("bot"), pinned: true })));
    out("project", renderToStaticMarkup(createElement(BotMenu, { ...base, bot: bot("manager"), pinned: false })));
    out("zh", renderToStaticMarkup(createElement(BotMenu, { ...base, bot: bot("bot"), pinned: false, lang: "zh-Hant" })));
    out("plugins", renderToStaticMarkup(createElement(BotMenu, { ...base, bot: bot("bot"), pinned: false, commands, onCommand() {} })));
  });
  it("page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const mounted = await mountPage({ shown: ID.alpha, plugins: pluginsWithMenus([
      { plugin: "zed.tools", menu: "bot/context", command: "zed.tools.run", title: "Run zed" },
      { plugin: "zed.tools", menu: "chat/link", command: "zed.tools.link", title: "Open link" },
      { plugin: "acme", menu: "bot/context", command: "acme.sync", title: "Sync <acme> & co" },
    ]) });
    await act(async () => { mounted.host.querySelector(`.bot-row[data-bot="${ID.beta}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })); });
    out("page", (mounted.host.querySelector(".bot-menu")?.outerHTML ?? "NONE").replace(/:r[0-9a-z]+:/g, ":rN:"));
    await mounted.unmount();
  });
});
