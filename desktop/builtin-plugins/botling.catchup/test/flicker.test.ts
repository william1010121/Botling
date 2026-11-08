// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import type { ChatState } from "../../../../Web/src/types";
import { line, openPage, withSummaries } from "./page";

globalThis.CSS ??= {} as typeof CSS;
CSS.escape ??= (text) => text.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

const make = (n: number, fold: string[], botID = "flick"): ChatState => withSummaries({
  botID, botName: "Garden",
  messages: Array.from({ length: n }, (_, i) => line(`m${i}`, i % 4 === 0 ? "user" : "bot")),
  working: false, avatar: "face", placeholder: "", replyingTo: null, pendingFiles: [], components: {},
  catchUp: { key: "k", kind: "unread", ids: fold, count: fold.length, heads: null, state: "ready", bullets: ["a"], error: null, model: "m", since: null, until: null, latest: null, manual: false, automatic: false, speakerCounts: null, requestedBy: null } as never,
});
const order = () => [...document.querySelectorAll<HTMLElement>("#messages > *")].map((e) => e.dataset.id ?? (e.classList.contains("decoration-extra") ? "DECO" : e.className));

beforeAll(openPage);

describe("streaming updates", () => {
  it("leave the cards and the folded rows alone", async () => {
    window.ccb.setState(make(40, ["m5", "m6", "m7"]));
    const card = document.querySelector(".decoration-extra")!;
    const log: string[] = [];
    const mo = new MutationObserver((records) => { for (const r of records) { const t = r.target as HTMLElement; if (t.closest?.(".decoration-extra") || [...r.addedNodes, ...r.removedNodes].some((n) => (n as HTMLElement).classList?.contains("decoration-extra"))) log.push(`${r.type}:${t.className}`); } });
    mo.observe(document.body, { childList: true, subtree: true });
    for (let i = 0; i < 5; i++) window.ccb.setState({ ...make(40 + (i > 2 ? 1 : 0), ["m5", "m6", "m7"]), working: true, live: [{ kind: "text", text: "x".repeat(i) }] } as never);
    await Promise.resolve(); mo.disconnect();
    expect(log).toEqual([]);
    expect(document.querySelector(".decoration-extra")).toBe(card);
  });
});

describe("a summary of old messages", () => {
  it("is not drawn while those messages are not mounted, and never at the end of the list", () => {
    window.ccb.setState(make(160, ["m3", "m4", "m5"], "old-bot"));
    expect(document.querySelector("#messages > .row")?.getAttribute("data-id")).toBe("m110");
    expect(document.querySelector(".decoration-extra")).toBeNull();
    window.ccb.setState(make(161, ["m3", "m4", "m5"], "old-bot"));
    expect(document.querySelector(".decoration-extra")).toBeNull();
  });
});

describe("repeated identical updates", () => {
  it("do not touch the DOM", () => {
    window.ccb.setState(make(40, ["m5", "m6", "m7"]));
    const log: string[] = [];
    const mo = new MutationObserver((records) => { for (const r of records) {
      const el = r.target as HTMLElement;
      // (Setting an attribute to the value it has is no change.)
      if (r.type === "attributes" && el.getAttribute(r.attributeName!) === r.oldValue) continue;
      log.push(`${r.type}:${el.className}:+${r.addedNodes.length}-${r.removedNodes.length}`);
    } });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true });
    for (let i = 0; i < 3; i++) window.ccb.setState(make(40, ["m5", "m6", "m7"]));
    return Promise.resolve().then(() => { mo.disconnect(); console.log(log.slice(0, 20)); expect(log).toEqual([]); });
  });
  it("places the card before the earliest folded row even if ids are listed newest first", () => {
    window.ccb.setState(make(40, ["m7", "m6", "m5"]));
    const o = order(); console.log(o.join(","));
    expect(o.indexOf("DECO")).toBe(o.indexOf("m5") - 1);
  });
});
