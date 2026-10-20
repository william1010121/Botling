import { beforeAll, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import type { ChatState, ComponentInfo, MessageView } from "../src/types";

// jsdom has no ResizeObserver; the chat follows sizes with one.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

function message(overrides: Partial<MessageView>): MessageView {
  return {
    id: "m1", role: "bot", text: "", stamp: null, avatar: "data:image/png;base64,AA==",
    choices: null, chosen: null, answer: null, open: false, display: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
    ...overrides,
  };
}

const info = (template: string, extra: Partial<ComponentInfo> = {}): ComponentInfo =>
  ({ template, version: 0, working: false, updated: false, hasPrevious: false, ...extra });

const components: Record<string, ComponentInfo> = {
  card: info("<p>card</p>"),
  chart: info("<p>chart</p>"),
  choices: info("<p>choices</p>"),
};

function state(messages: MessageView[], overrides: Partial<ChatState> = {}): ChatState {
  return {
    botID: "b1", botName: "Main bot", messages, working: false, avatar: "", placeholder: "",
    replyingTo: null, pendingFiles: [], components, ...overrides,
  };
}

/** Counts every srcdoc these frames are given from here on. */
function watchSrcdoc(...watched: HTMLIFrameElement[]): { count: number } {
  const counter = { count: 0 };
  const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc")!;
  for (const frame of watched) Object.defineProperty(frame, "srcdoc", {
    configurable: true,
    get() { return descriptor.get!.call(this); },
    set(value: string) { counter.count++; descriptor.set!.call(this, value); },
  });
  return counter;
}

const frames = () => [...document.querySelectorAll<HTMLIFrameElement>("#messages iframe.component-frame")];

beforeAll(async () => {
  document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
  await import("../src/main");
});

describe("components in the chat", () => {
  it("keep their frames while the reply around them streams and the chat goes on", () => {
    const reply = (text: string, extra: Partial<MessageView> = {}) => message({
      text,
      displays: [
        { name: "card", data: "{\"a\":1}", at: 0 },
        { name: "chart", data: "{\"b\":2}", at: null, images: { "/x/a.png": "ccb-preview:a", "/x/b.png": "ccb-preview:b" } },
      ],
      ...extra,
    });
    window.ccb.setState(state([reply("Here")], { working: true }));
    const [card, chart] = frames();
    expect(frames()).toHaveLength(2);
    const srcdoc = watchSrcdoc(card, chart);

    // More words stream in, steps change, the bot finishes, and a new message comes after.
    window.ccb.setState(state([reply("Here it is")], { working: true }));
    window.ccb.setState(state([reply("Here it is.", { steps: [{ id: "s", kind: "tool", tool: "Bash", title: "ls", detail: null, output: null, failed: false, done: true, status: null, count: null }] })]));
    window.ccb.setState(state([
      reply("Here it is.", { displays: [
        { name: "card", data: "{\"a\":1}", at: 0 },
        // The same pictures in another order (a Swift dictionary has none).
        { name: "chart", data: "{\"b\":2}", at: null, images: { "/x/b.png": "ccb-preview:b", "/x/a.png": "ccb-preview:a" } },
      ] }),
      message({ id: "m2", role: "user", text: "thanks" }),
    ], { components: { ...components, other: info("<p>other</p>", { working: true }) } }));

    expect(frames()[0]).toBe(card);
    expect(frames()[1]).toBe(chart);
    expect(card.isConnected && chart.isConnected).toBe(true);
    expect(srcdoc.count).toBe(0);
    expect(document.querySelector("#messages .row.bot .markdown")?.textContent).toContain("Here it is.");
  });

  it("rebuild only the component whose data changed, keeping its height", () => {
    const reply = (b: string) => message({
      id: "m3", text: "Two",
      displays: [{ name: "card", data: "{\"a\":1}", at: null }, { name: "chart", data: b, at: null }],
    });
    window.ccb.setState(state([reply("{\"b\":1}")]));
    const [card, chart] = frames();
    window.dispatchEvent(new MessageEvent("message", { data: { ccb: "size", height: 120 }, source: chart.contentWindow }));
    window.ccb.setState(state([reply("{\"b\":2}")]));
    expect(frames()[0]).toBe(card);
    expect(frames()[1]).not.toBe(chart);
    expect(frames()[1].srcdoc).toContain("{\"b\":2}");
    expect(frames()[1].style.height).toBe("120px");
  });

  it("redraw a question's component once it is answered, and send later answers with the new state", () => {
    const question = (extra: Partial<MessageView>) => message({
      id: "m4", text: "Which?", choices: [{ label: "A", detail: null, recommended: false }, { label: "B", detail: null, recommended: false }],
      ...extra,
    });
    window.ccb.setState(state([question({ open: true })]));
    const before = frames()[0];
    window.ccb.setState(state([question({ open: true, text: "Which one?" })]));
    expect(frames()[0]).toBe(before);
    // The kept frame still answers its message.
    sent.length = 0;
    window.dispatchEvent(new MessageEvent("message", { data: { ccb: "answer", index: 1 }, source: before.contentWindow }));
    expect(sent).toEqual([{ type: "choose", messageID: "m4", index: 1 }]);
    window.ccb.setState(state([question({ open: false, chosen: 1 })]));
    // Answered: folded to what was picked, the open frame gone.
    expect(document.querySelector(".row[data-id=\"m4\"] .folded-choice")?.textContent).toContain("B");
    expect(document.querySelector(".row[data-id=\"m4\"] iframe")).toBeNull();
  });
});
