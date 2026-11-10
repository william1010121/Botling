// @vitest-environment jsdom
// The folded left column (RailStrip) lists the rows the open column keeps above its Idle group (the main bot,
// Maintainer, pinned and the rest), never the idle bots, and draws no unread dot beside a face (no room there).
// jsdom only: no window, no focus taken.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RailStrip } from "../../src/renderer/App";
import { railSplit } from "../../src/renderer/rail-idle";
import { MAINTAINER_BOT_ID, type BotView } from "../../src/contract";

const base: BotView = { id: "a", name: "a", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const main: BotView = { ...base, id: "m", name: "Main bot", role: "main" };
const keeper: BotView = { ...base, id: MAINTAINER_BOT_ID, name: "Maintainer", role: "bot" };
const busy: BotView = { ...base, id: "busy", name: "busy", working: true, unread: 3 };
const pin: BotView = { ...base, id: "pin", name: "pin", unread: 2 };
const sleepy: BotView = { ...base, id: "sleepy", name: "sleepy", unread: 5 };
const pinnedIdle: BotView = { ...base, id: "pinnedIdle", name: "pinnedIdle" };
const bots = [main, keeper, busy, pin, sleepy, pinnedIdle];
const pinned = ["pin", "pinnedIdle"];
const idle = ["sleepy", "pinnedIdle", MAINTAINER_BOT_ID];

describe("folded column rows", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(RailStrip, {
      bots, pinned, idle, look: "original", shown: null, waiting: () => false, onSelect() {},
      onMenu() {}, onExpand() {}, onAddProject() {}, onNewBot() {}, settingsControl: null,
    })));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });
  const faces = () => [...host.querySelectorAll<HTMLButtonElement>(".strip-bot")].map((face) => face.dataset.bot);

  it("shows exactly the open column's rows above Idle, leaving the idle bots out", () => {
    expect(faces()).toEqual(railSplit(bots, pinned, idle).rows.map(({ bot }) => bot.id));
    expect(faces()).toEqual(["m", MAINTAINER_BOT_ID, "pin", "busy"]);
  });

  it("draws no unread dot beside a face, but still says the unread count to a screen reader", () => {
    expect(host.querySelector(".strip-unread")).toBeNull();
    expect(host.querySelector('.strip-bot[data-bot="busy"]')?.getAttribute("aria-label")).toContain("3 unread");
  });
});
