import { beforeAll, describe, expect, it } from "vitest";
import type { ChatState } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const state = (extra: Partial<ChatState> = {}): ChatState => ({
  botID: "botling", botName: "botling", messages: [], working: false,
  avatar: "botling-avatar", placeholder: "Message botling…", replyingTo: null, pendingFiles: [], components: {}, ...extra,
});
const rows = () => [...document.querySelectorAll(".call-in-status")].map((row) => row.textContent);

beforeAll(async () => {
  document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
  await import("../src/main");
});

describe("call-ins still out", () => {
  it("names who is answering and who is queued, after the chat's own typing bubble, and clears when answered", () => {
    const calls: ChatState["callIns"] = [{ name: "flux-k8s", state: "answering" }, { name: "flux-k8s", state: "queued" }];
    window.ccb.setState(state({ lang: "zh-Hant", working: true, callIns: calls }));
    expect(rows()).toEqual(["flux-k8s 正在回答…", "flux-k8s 排隊中"]);
    expect(document.querySelector(".typing")).not.toBeNull();
    const list = document.getElementById("messages")!;
    expect(list.lastElementChild?.classList.contains("call-in-status")).toBe(true);
    window.ccb.setState(state({ lang: "zh-Hant", callIns: [{ name: "flux-k8s", state: "answering" }] }));
    expect(rows()).toEqual(["flux-k8s 正在回答…"]);
    window.ccb.setState(state({ callIns: [] }));
    expect(rows()).toEqual([]);
  });

  it("shows in the callee's own chat where it is answering, and not in another chat", () => {
    window.ccb.setState(state({ lang: "en", botID: "flux", botName: "flux-k8s", answeringIn: "botling" }));
    expect(rows()).toEqual(["Answering an @ in botling's chat…"]);
    window.ccb.setState(state({ botID: "other" }));
    expect(rows()).toEqual([]);
  });
});
