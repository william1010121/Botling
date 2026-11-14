import { beforeAll, describe, expect, it } from "vitest";
import type { ChatState, MessageView } from "../src/types";

// The chat page keeps a reply's video while the reply is drawn again (M1 demo bugs 1 and 6): while its words stream in,
// a new <video> per redraw took 340–600 ms to its first frame, and a redraw of a finished reply put a playing video back
// at 0:00, paused.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

function message(overrides: Partial<MessageView>): MessageView {
  return {
    id: "m1", role: "bot", text: "", stamp: null, avatar: "data:image/png;base64,AA==",
    choices: null, chosen: null, answer: null, open: false, display: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
    ...overrides,
  };
}

function state(messages: MessageView[], overrides: Partial<ChatState> = {}): ChatState {
  return { botID: "b1", botName: "Main bot", messages, working: false, avatar: "", placeholder: "", replyingTo: null, pendingFiles: [], components: {}, ...overrides };
}

const VIDEO = "botling-chat://chat/attachment/b1/AAAA/demo-video.mp4?line=m1";
const OTHER = "botling-chat://chat/attachment/b1/BBBB/other.mp4?line=m1";
const videos = () => [...document.querySelectorAll<HTMLVideoElement>("#messages video")];

beforeAll(async () => {
  document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
  await import("../src/main");
});

describe("a reply's video", () => {
  it("stays the same element while the reply's words stream in and after it finishes", () => {
    const words = ["Rendered", "the video:", `![demo video](${VIDEO})`, "and wrote", "the PDF:", "[demo-doc.pdf](botling-chat://chat/attachment/b1/CCCC/demo-doc.pdf)"];
    window.ccb.setState(state([message({ text: words.slice(0, 3).join(" ") })], { working: true }));
    const [first] = videos();
    expect(first?.getAttribute("src")).toContain("demo-video.mp4");
    for (let n = 4; n <= words.length; n += 1) {
      window.ccb.setState(state([message({ text: words.slice(0, n).join(" ") })], { working: true }));
      expect(videos()).toHaveLength(1);
      expect(videos()[0]).toBe(first);
    }
    // Finished, then another reply comes after it, then the stamp over it changes: still the very element.
    window.ccb.setState(state([message({ text: words.join(" ") })]));
    window.ccb.setState(state([message({ text: words.join(" ") }), message({ id: "m2", text: "next" })]));
    window.ccb.setState(state([message({ text: words.join(" "), stamp: "Today 3:00 PM" }), message({ id: "m2", text: "next" })]));
    expect(videos()).toHaveLength(1);
    expect(videos()[0]).toBe(first);
    expect(first.isConnected).toBe(true);
    expect(first.getAttribute("src")).toContain("demo-video.mp4");
  });

  it("is a new element when the reply names another file in its place", () => {
    window.ccb.setState(state([message({ id: "m3", text: `![a](${VIDEO})` })]));
    const [before] = videos();
    window.ccb.setState(state([message({ id: "m3", text: `![b](${OTHER})` })]));
    const [after] = videos();
    expect(after).not.toBe(before);
    expect(after.getAttribute("src")).toContain("other.mp4");
  });
});

/** Makes `video` play from `at` seconds, as a real one does (jsdom plays nothing); counts what is asked of it. */
function playFrom(video: HTMLVideoElement, at: number): { plays: number; pauses: number } {
  const asked = { plays: 0, pauses: 0 };
  let paused = false;
  video.currentTime = at;
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  Object.defineProperty(video, "play", { configurable: true, value: () => { paused = false; asked.plays += 1; return Promise.resolve(); } });
  Object.defineProperty(video, "pause", { configurable: true, value: () => { paused = true; asked.pauses += 1; } });
  return asked;
}

describe("a playing video in a reply", () => {
  const card = { template: "<p>card</p>", version: 0, working: false, updated: false, hasPrevious: false };

  it("plays on from where it is while the reply streams, finishes and gets a stamp (moved atomically, as Electron's Chromium does)", () => {
    const proto = Element.prototype as unknown as { moveBefore?: (node: Node, child: Node | null) => void };
    proto.moveBefore = function (this: Element, node: Node, child: Node | null) { this.insertBefore(node, child); };
    try {
      window.ccb.setState(state([message({ id: "p1", text: `Here: ![clip](${VIDEO})` })], { working: true }));
      const [video] = videos();
      const asked = playFrom(video, 42);
      for (const more of [" it", " is", " — enjoy"]) {
        window.ccb.setState(state([message({ id: "p1", text: `Here: ![clip](${VIDEO})${more}` })], { working: true }));
      }
      window.ccb.setState(state([message({ id: "p1", text: `Here: ![clip](${VIDEO}) done`, stamp: "Today 3:00 PM" })]));
      const [shown] = videos();
      expect(shown.currentTime).toBe(42);
      expect(shown.paused).toBe(false);
      expect(asked).toEqual({ plays: 0, pauses: 0 });
    } finally {
      delete proto.moveBefore;
    }
  });

  it("plays on from where it is when its reply also has a card (a result page's preview) and is drawn again", () => {
    const reply = (text: string) => message({ id: "p2", text, previews: [{ name: "card", data: "{\"url\":\"report.html\"}" }] });
    window.ccb.setState(state([reply(`Here: ![clip](${VIDEO})`)], { components: { card }, working: true }));
    const [video] = videos();
    const frame = document.querySelector("#messages iframe.component-frame");
    expect(frame).not.toBeNull();
    playFrom(video, 7.5);
    window.ccb.setState(state([reply(`Here: ![clip](${VIDEO}) and the report`)], { components: { card } }));
    // The card's frame was kept (the row patched in place), and so was the video.
    expect(document.querySelector("#messages iframe.component-frame")).toBe(frame);
    expect(videos()).toHaveLength(1);
    const [shown] = videos();
    expect(shown).toBe(video);
    expect(shown.currentTime).toBe(7.5);
    expect(shown.paused).toBe(false);
  });

  it("goes with its reply when the reply is removed", () => {
    window.ccb.setState(state([message({ id: "p3", text: `![clip](${VIDEO})` }), message({ id: "p4", text: "after" })]));
    const [video] = videos();
    window.ccb.setState(state([message({ id: "p4", text: "after" })]));
    expect(videos()).toHaveLength(0);
    expect(video.isConnected).toBe(false);
  });
});
