// @vitest-environment jsdom
// Regression: the chat jumped to a message in the middle and could not be scrolled to the bottom.
// The "Summarize N replies" buttons asked for the row of every stretch's last reply, including those
// outside the mounted window; asking for an unmounted row made the page mount that older window.
import { beforeAll, describe, expect, it } from "vitest";
import { sent } from "../../../../Web/src/bridge";
import type { ChatState } from "../../../../Web/src/types";
import { line, openPage, withSummaries } from "./page";

globalThis.CSS ??= {} as typeof CSS;
CSS.escape ??= (text) => text.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

const many =(): ChatState => withSummaries({
  botID: "jump-bot", botName: "Garden",
  messages: Array.from({ length: 160 }, (_, i) => line(`m${i}`, i % 4 === 0 ? "user" : "bot")),
  working: false, avatar: "face", placeholder: "", replyingTo: null, pendingFiles: [], components: {},
});
const ids = () => [...document.querySelectorAll<HTMLElement>("#messages > .row")].map((row) => row.dataset.id);

beforeAll(openPage);

describe("catch-up triggers and the history window", () => {
  it("leave the chat on its latest messages, and do not ask the page to reveal older ones", () => {
    const revealed: unknown[] = [];
    document.addEventListener("ccb-reveal-message", (event) => revealed.push((event as CustomEvent).detail));
    window.ccb.setState(many());
    window.ccb.setState(many());
    expect(sent.filter((s) => (s as { type: string }).type === "pluginError")).toEqual([]);
    expect(document.querySelectorAll(".interval-summary-trigger").length).toBeGreaterThan(0);
    expect(revealed).toEqual([]);
    expect(ids().at(-1)).toBe("m159");
    expect(ids()[0]).toBe("m110");
    expect(document.querySelector(".history-latest")?.hasAttribute("hidden")).toBe(true);
  });
});
