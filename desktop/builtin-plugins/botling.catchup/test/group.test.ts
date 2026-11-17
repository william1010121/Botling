// @vitest-environment jsdom
// The fold's header in the real chat page: the page places it and folds the lines (Web/src/decorations.ts), this
// plugin's web part draws it (src/group.ts). A small header, no summary: "While you were away · N important" and a
// button that opens the folded messages.
import { beforeAll, describe, expect, it } from "vitest";
import type { ChatState, MessageView } from "../../../../Web/src/types";
import { catchupCSS, chatCSS, line, openPage, withSummaries } from "./page";
import type { CatchUpView } from "../src/types";

const view = (extra: Partial<CatchUpView> = {}): CatchUpView => ({ key: "k1", kind: "unread", ids: ["b", "c", "d"], important: 3, ...extra });
const state = (catchUp: CatchUpView | null, extra: Partial<ChatState> = {}): ChatState => withSummaries({
  botID: "catchup-bot", botName: "Garden", messages: ["a", "b", "c", "d", "e", "f", "g"].map((id) => line(id, id === "a" ? "user" : "bot")),
  working: false, avatar: "face", placeholder: "", replyingTo: null, pendingFiles: [], components: {}, catchUp, ...extra,
});
const rows = () => [...document.querySelectorAll<HTMLElement>("#messages > .row")];
const order = () => [...document.querySelectorAll<HTMLElement>("#messages > *")].map((el) =>
  el.classList.contains("catchup-head") ? "HEAD" : el.dataset.id ?? "?");

beforeAll(openPage);

describe("catch-up header", () => {
  it("folds the other rows behind a small header placed before the first, without moving the rows", () => {
    window.ccb.setState(state(view()));
    const before = rows();
    expect(order()).toEqual(["a", "HEAD", "b", "c", "d", "e", "f", "g"]);
    expect(before.filter((row) => row.classList.contains("decoration-folded")).map((row) => row.dataset.id)).toEqual(["b", "c", "d"]);
    // The picked ones are ordinary live rows.
    for (const id of ["e", "f", "g"]) expect(document.querySelector(`[data-id="${id}"]`)?.classList.contains("decoration-folded")).toBe(false);
    const card = document.querySelector(".catchup-card")!;
    expect(card.getAttribute("aria-label")).toBe("While you were away");
    expect(card.querySelector(".catchup-title")?.textContent).toBe("While you were away · 3 important");
    // No summary: no bullets, no loading, no model byline, no retry.
    expect(card.querySelector(".catchup-bullets, .catchup-writing, .catchup-by, .catchup-error-title, [data-action=\"retry\"]")).toBeNull();
    expect(card.querySelectorAll("li")).toHaveLength(0);
    // A later update keeps the same row elements in place.
    window.ccb.setState(state(view(), { working: false }));
    expect(rows()).toEqual(before);
    expect(order()).toEqual(["a", "HEAD", "b", "c", "d", "e", "f", "g"]);
  });

  it("says nothing about importance when no message stayed in view", () => {
    window.ccb.setState(state(view({ important: 0 })));
    expect(document.querySelector(".catchup-title")?.textContent).toBe("While you were away");
  });

  it("speaks the chat's language", () => {
    window.ccb.setState(state(view(), { lang: "zh-Hant" }));
    expect(document.querySelector(".catchup-title")?.textContent).toBe("你不在時 · 3 件重要");
    window.ccb.setState(state(view(), { lang: "en" }));
    expect(document.querySelector(".catchup-title")?.textContent).toBe("While you were away · 3 important");
  });

  it("opens the folded originals in a centered viewer while keeping the main rows folded", () => {
    window.ccb.setState(state(view()));
    const originals = rows();
    const toggle = document.querySelector<HTMLButtonElement>('[data-action="toggle"]')!;
    // "Show N messages" opens the originals over the page; there is no button that dissolves the fold.
    expect(toggle.textContent).toBe("Show 3 messages↗");
    expect(toggle.getAttribute("aria-haspopup")).toBe("dialog");
    expect(document.querySelector('[data-action="expand"]')).toBeNull();
    toggle.focus(); toggle.click();
    expect(document.querySelectorAll("#messages .decoration-folded")).toHaveLength(3);
    expect(order()).toEqual(["a", "HEAD", "b", "c", "d", "e", "f", "g"]);
    expect([...document.querySelectorAll<HTMLElement>(".summary-source-viewer .source-message")].map((n) => n.dataset.sourceId)).toEqual(["b", "c", "d"]);
    expect(document.querySelector(".summary-source-viewer .source-header")?.textContent).toContain("3 messages");
    expect(rows()).toEqual(originals);
    document.querySelector<HTMLButtonElement>("[data-source-close]")!.click();
    expect(document.querySelector(".summary-source-viewer")).toBeNull();
    expect(document.querySelectorAll("#messages .decoration-folded")).toHaveLength(3);
    expect(document.activeElement?.getAttribute("data-action")).toBe("toggle");
  });

  it("removes the header and unfolds when there is no fold", () => {
    window.ccb.setState(state(view()));
    window.ccb.setState(state(null));
    expect(document.querySelector(".catchup-head")).toBeNull();
    expect(document.querySelectorAll(".decoration-folded")).toHaveLength(0);
    expect(order()).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("puts no \"Summarize N replies\" button anywhere: intervals are gone", () => {
    window.ccb.setState(state(null, { messages: [line("u1", "user"), line("b1"), line("n", "notice"), line("b2"), line("u2", "user"), line("b3")] }));
    expect(document.querySelector(".interval-summary-trigger, .interval-summary-head")).toBeNull();
    expect(document.querySelector(".catchup-button")).toBeNull();
  });

  it("folds timestamped component requests and attachments in the folded range", () => {
    const style = document.createElement("style");
    style.textContent = chatCSS + catchupCSS;
    document.head.append(style);
    const request = (id: string, stamp: string): MessageView => ({ ...line(id, "relay"), stamp,
      reactionEnabled: true, attachments: [{ name: `${id}.png`, kind: "image", url: `file:///tmp/${id}.png` }] });
    const messages = [line("boundary", "user"), line("reply"), request("contribution", "Today 9:11 pm"),
      request("token", "Today 10:17 pm"), line("last"), line("next", "user"), request("later", "Later")];
    const ids = ["reply", "contribution", "token", "last"];
    const container = (id: string) => {
      const row = document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
      return row.closest<HTMLElement>(".stamped") ?? row;
    };
    try {
      window.ccb.setState(state(view({ key: "stamped", ids }), { messages }));
      for (const id of ids) expect(getComputedStyle(container(id)).display, id).toBe("none");
      for (const id of ["boundary", "next", "later"]) expect(getComputedStyle(container(id)).display).not.toBe("none");
      const original = container("contribution"), image = original.querySelector("img.thumb");
      document.querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
      expect(container("contribution")).toBe(original);
      expect(original.querySelector("img.thumb")).toBe(image);
      expect(image).not.toBeNull();
      for (const id of ids) expect(getComputedStyle(container(id)).display).toBe("none");
      expect(document.querySelectorAll(".source-message")).toHaveLength(ids.length);
      document.querySelector<HTMLButtonElement>("[data-source-close]")!.click();
      expect(getComputedStyle(original).display).toBe("none");
      window.ccb.setState(state(null, { messages }));
      for (const id of ids) expect(getComputedStyle(container(id)).display).not.toBe("none");
    } finally { style.remove(); }
  }, 30000);
});
