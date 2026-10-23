import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnimatedHead, CharacterClip, ChatState, MessageView } from "../src/types";

let reduced = false;
let mediaChanged: (() => void) | undefined;
let heads: AnimatedHead[];
let sequence = 0;
const rect = (visible = true): DOMRect => ({ x: 10, y: visible ? 20 : 2000, width: 48, height: 48, top: visible ? 20 : 2000, bottom: visible ? 68 : 2048, left: 10, right: 58, toJSON() {} });

const message = (id: string, extra: Partial<MessageView> = {}): MessageView => ({
  id, role: "bot", text: "Reply", stamp: null, avatar: heads[0].avatar, choices: null, chosen: null,
  answer: null, open: false, attachments: null, replyTo: null, replyPreview: null, openable: false, ...extra,
});
const state = (extra: Partial<ChatState> = {}): ChatState => ({
  botID: `animation-${sequence}`, botName: "Bot", messages: [], working: false, avatar: heads[0].avatar,
  placeholder: "", replyingTo: null, pendingFiles: [], components: {}, animatedHeads: heads,
  seenHeads: { C: "c", X: "x" }, avatarMood: "normal", ...extra,
});
const active = () => [...document.querySelectorAll<HTMLImageElement>(".avatar-motion[src]")];

beforeAll(async () => {
  Range.prototype.getClientRects ??= (() => []) as unknown as typeof Range.prototype.getClientRects;
  Range.prototype.getBoundingClientRect ??= () => rect();
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof IntersectionObserver;
  window.matchMedia = (() => ({ get matches() { return reduced; }, addEventListener: (_: string, fn: () => void) => { mediaChanged = fn; } })) as unknown as typeof window.matchMedia;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return rect(this.dataset.offscreen !== "true"); });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
  document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
  await import("../src/main");
});

beforeEach(() => {
  sequence++;
  reduced = false;
  heads = ["claude", "codex"].map((engine) => ({
    engine, avatar: `portrait-${engine}-${sequence}`, thinking: `think-${engine}`, sleeping: `sleep-${engine}`, hat: "hat",
    clips: (["avatar", "sticker"] as const).flatMap((kind) => (["blink", "typing", "wave"] as const).map((action): CharacterClip => ({
      id: `${engine}-${kind}-${action}`, engine, kind, action, file: `file:///${sequence}/${engine}/${kind}/${action}.gif`, poster: "poster.png", duration: 640,
    }))),
  }));
  window.ccb.setWindowVisible(true);
  window.ccb.setState(state());
});
afterEach(() => vi.useRealTimers());

describe("actual GIF avatar lifecycle", () => {
  it("animates only the latest visible reply; never 100 history avatars", () => {
    window.ccb.setState(state({ botID: "initial-history", messages: Array.from({ length: 100 }, (_, i) => message(`m${i}`)) }));
    expect(document.querySelectorAll(".animated-avatar")).toHaveLength(100);
    expect(active()).toHaveLength(1);
    expect(active()[0].src).toContain("blink.gif");
    expect(active()[0].closest(".row")?.getAttribute("data-id")).toBe("m99");
  });

  it("keeps the live GIF node and source through stream patches; waiting uses static thinking art", () => {
    const liveState = state({ working: true, messages: [message("old")] });
    window.ccb.setState(liveState);
    const live = active()[0];
    expect(live.src).toContain("typing.gif");
    window.ccb.setState({ ...liveState, live: [{ id: "tool", kind: "tool", title: "Check", tool: "Read", detail: null, output: null, failed: false, done: false, status: null, count: null }] });
    expect(active()[0]).toBe(live);
    window.ccb.setState({ ...liveState, avatarMood: "think" });
    expect(active()).toHaveLength(0);
    expect(document.querySelector<HTMLImageElement>(".typing .avatar-still")!.getAttribute("src")).toBe(heads[0].thinking);
  });

  it("plays completion wave once, then returns to blink; failures and interruptions stay still", () => {
    vi.useFakeTimers();
    window.ccb.setState(state({ working: true }));
    window.ccb.setState(state({ messages: [message("done")] }));
    expect(active()[0].src).toContain("wave.gif");
    vi.advanceTimersByTime(650);
    expect(active()[0].src).toContain("blink.gif");
    window.ccb.setState(state({ messages: [message("done"), message("err", { role: "error", avatar: null })] }));
    expect(active()).toHaveLength(0);
    window.ccb.setState(state({ messages: [message("interrupted", { interrupted: true })] }));
    expect(active()).toHaveLength(0);
    expect(document.querySelector<HTMLImageElement>(".avatar-still")!.getAttribute("src")).toBe(heads[0].sleeping);
  });

  it("unloads on native occlusion, offscreen, reduced motion and chat switch", async () => {
    const { refreshAvatarVisibility } = await import("../src/animated-avatar");
    window.ccb.setState(state({ working: true }));
    expect(active()).toHaveLength(1);
    window.ccb.setWindowVisible(false);
    expect(active()).toHaveLength(0);
    window.ccb.setWindowVisible(true);
    expect(active()).toHaveLength(1);
    const avatar = document.querySelector<HTMLElement>(".typing .avatar")!;
    avatar.dataset.offscreen = "true";
    refreshAvatarVisibility();
    expect(active()).toHaveLength(0);
    avatar.dataset.offscreen = "false";
    refreshAvatarVisibility();
    reduced = true;
    mediaChanged?.();
    expect(active()).toHaveLength(0);
    reduced = false;
    mediaChanged?.();
    expect(active()).toHaveLength(1);
    const old = active()[0];
    window.ccb.setState(state({ botID: "other", animatedHeads: null, avatar: "custom", working: true }));
    expect(old.hasAttribute("src")).toBe(false);
    expect(document.querySelector(".typing .avatar")?.tagName).toBe("IMG");
  });

  it("falls back after a load error and does not repeatedly retry a broken GIF", () => {
    window.ccb.setState(state({ working: true }));
    active()[0].dispatchEvent(new Event("error"));
    expect(active()).toHaveLength(0);
    window.ccb.setState(state({ working: true }));
    expect(active()).toHaveLength(0);
    expect(document.querySelector<HTMLImageElement>(".typing .avatar-still")!.getAttribute("src")).toBe(heads[0].avatar);
  });

  it("exposes all twelve clips with a single explicit preview; leaves emoji reactions alone", () => {
    window.ccb.setState(state({ messages: [message("preview", { reactionEnabled: true })] }));
    document.querySelector<HTMLButtonElement>("button.animated-avatar")!.click();
    const choices = document.querySelectorAll<HTMLButtonElement>(".avatar-library-grid button");
    expect(choices).toHaveLength(12);
    expect(active()).toHaveLength(1);
    const sticker = [...choices].find((button) => button.dataset.clip === "codex-sticker-wave")!;
    sticker.click();
    expect(active()[0].src).toContain("codex/sticker/wave.gif");
    expect(active()[0].closest(".avatar-preview")?.getAttribute("data-clip")).toBe("codex-sticker-wave");
    expect(document.querySelectorAll(".reaction-palette button")).toHaveLength(6);
    document.querySelector<HTMLDialogElement>("dialog")!.close();
    expect(document.querySelector("dialog")).toBeNull();
    expect(active()).toHaveLength(1);
  });

  it("does not animate sleeping heads or Original/custom faces", () => {
    window.ccb.setState(state({ avatarMood: "sleep", messages: [message("sleep")] }));
    expect(active()).toHaveLength(0);
    window.ccb.setState(state({ animatedHeads: null, avatar: "custom-face", working: true, messages: [message("original", { avatar: "custom-face" })] }));
    expect(document.querySelectorAll(".animated-avatar")).toHaveLength(0);
    expect(document.querySelector<HTMLImageElement>(".typing .avatar")!.getAttribute("src")).toBe("custom-face");
  });
});
