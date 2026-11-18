// @vitest-environment jsdom
// The Note's cards must not flicker (the invariant: no flash, no blank frame, no jump in size), mounted from source in jsdom
// as ui-mount.test.js does (run through ui-cards-flicker-run.test.ts). What is pinned here:
//  - new data for a card whose frame takes live data (`ccb.onData`, announced with { ccb: "live" }) is posted to the frame as
//    the JSON text the card page reads ({ ccbData: "<json>" }, not an object: the page ignores an object), and the iframe
//    stays the same node;
//  - a card that needs a new page (other component, other picture map, or a frame that does not take live data) keeps its
//    old iframe on screen, at its height, until the new page says it is ready ({ ccb: "ready", height }: loaded, painted,
//    pictures decoded, sized; its `load` event is not that), then swaps; a page asked for data that is no longer wanted is
//    dropped; a page that never gets ready, or cannot be made, leaves the old one in place;
//  - the reply of notes.cards is matched to the cards of the text it was asked about (not to the lines they are on now);
//  - typing in the note keeps the frame (the same node, the same height).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../src/ui.js";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  Element.prototype.getBoundingClientRect = function () {
    const p = this.parentElement;
    if (p && p.classList.contains("note-doc")) return rect(0, [...p.children].indexOf(this) * 100, 600, 80);
    return rect(0, 0, 0, 0);
  };
  document.elementFromPoint = () => null;
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  try { localStorage.clear(); } catch {}
  vi.useFakeTimers();
});
let current = null;
afterEach(() => {
  current?.stop?.();
  current = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  Element.prototype.getBoundingClientRect = realRect;
});

const SHOW = /^<show name="([^"]+)">(.*)<\/show>$/;
// The card is "running" all along, so the page asks the app again every 2 s (what a card with a refresh does).
function makeEnv(text) {
  const env = { text, mtime: 1, calls: [], cardCalls: [], manual: false, failCard: false, hold: null, data: null, images: {}, handlers: {}, stop: null };
  env.cardsOf = (t) => t.split("\n").flatMap((l, line) => {
    const m = SHOW.exec(l);
    return m ? [{ line, name: m[1], key: `k${line}`, exists: true, status: env.status ?? "running", data: env.data ?? m[2], command: "date", every: null, images: env.images }] : [];
  });
  env.ccb = {
    context: { botId: "B1" },
    panels: { register: (id, fn) => { env.view_fn = fn; } },
    host: {
      call: async (method, params) => {
        if (method.startsWith("margin")) return method === "marginList" ? { threads: [] } : null;
        env.calls.push(method);
        if (method === "read") return { text: env.text, mtime: env.mtime };
        if (method === "write") { env.text = params.text; env.mtime += 1; return { saved: true, mtime: env.mtime }; }
        if (method === "viewGet") return null;
        if (method === "viewSet") return null;
        if (method === "cards") {
          const list = env.cardsOf(params.text);
          if (env.hold) { await env.hold; env.hold = null; }
          return list;
        }
        if (method === "components") return { components: [] };
        if (method === "assetUrls") return {};
        return null;
      },
    },
    on: (name, fn) => { env.handlers[name] = fn; return () => { delete env.handlers[name]; }; },
    notify() {},
    card: ({ component, data }) => new Promise((resolve, reject) => {
      const call = { component, data, url: `https://card.invalid/${component}/${env.cardCalls.length + 1}`, resolve: () => resolve(call.url), reject: () => reject(new Error("no page")) };
      env.cardCalls.push(call);
      if (env.failCard) reject(new Error("no page"));
      else if (!env.manual) resolve(call.url);
    }),
    snapshot: async () => null,
  };
  return env;
}
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
async function open(text, env = makeEnv(text)) {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.append(root);
  activate(env.ccb);
  env.stop = env.view_fn(root);
  env.root = root;
  current = env;
  await settle(10);
  return env;
}
const q = (env, sel) => env.root.querySelector(sel);
// the very nodes (toEqual would take two iframes with the same attributes for the same one)
const is = (list, ...nodes) => {
  expect(list).toHaveLength(nodes.length);
  nodes.forEach((node, i) => expect(list[i]).toBe(node));
};
const frames = (env) => [...env.root.querySelectorAll(".nc-layer .nc-frame")];
const TEXT = 'intro\n<!-- cell -->\n<show name="weather">{"city":"Taipei"}</show>\n';
const announce = (frame) => window.dispatchEvent(new MessageEvent("message", { data: { ccb: "live" }, source: frame.contentWindow }));
const sized = (frame, height) => window.dispatchEvent(new MessageEvent("message", { data: { ccb: "size", height }, source: frame.contentWindow }));
const ready = (frame, height = 300) => window.dispatchEvent(new MessageEvent("message", { data: { ccb: "ready", height }, source: frame.contentWindow }));
// the page's own word that it can take the place of the shown one (its `load` event first, as a real page has it)
const painted = async (frame, height) => { frame.dispatchEvent(new Event("load")); ready(frame, height); await settle(0); };
// the card drawn and at 300 px
async function drawn(text = TEXT) {
  const env = await open(text);
  await settle(400);
  const [frame] = frames(env);
  expect(frame).toBeDefined();
  sized(frame, 300);
  await settle(0);
  expect(frame.style.height).toBe("300px");
  return { env, frame };
}

describe("a card's new data", () => {
  it("goes to a frame that takes live data as JSON text, and the iframe stays the same node", async () => {
    const { env, frame } = await drawn();
    announce(frame);
    const posted = vi.spyOn(frame.contentWindow, "postMessage");
    env.data = '{"city":"Tokyo"}';
    await settle(2100);
    is(frames(env), frame);
    expect(env.cardCalls).toHaveLength(1);
    expect(posted).toHaveBeenCalledTimes(1);
    const [message, target] = posted.mock.calls[0];
    expect(target).toBe("*");
    expect(typeof message.ccbData).toBe("string");
    expect(JSON.parse(message.ccbData)).toEqual({ city: "Tokyo" });
    expect(frame.style.height).toBe("300px");
  });

  it("is sent once: a later sync with the same data posts nothing", async () => {
    const { env, frame } = await drawn();
    announce(frame);
    env.data = '{"city":"Tokyo"}';
    await settle(2100);
    const posted = vi.spyOn(frame.contentWindow, "postMessage");
    await settle(4100);
    expect(posted).not.toHaveBeenCalled();
  });

  it("is not sent when the app has nothing to show for the card yet (its command runs again): the frame keeps what it shows", async () => {
    const { env, frame } = await drawn();
    announce(frame);
    const posted = vi.spyOn(frame.contentWindow, "postMessage");
    env.data = "null";
    await settle(2100);
    expect(posted).not.toHaveBeenCalled();
    is(frames(env), frame);
    expect(env.cardCalls).toHaveLength(1);
    expect(frame.style.display).toBe("block");
  });

  it("for a frame that does not take live data keeps the old frame at its height until the new page has loaded and painted", async () => {
    const { env, frame } = await drawn();
    env.data = '{"city":"Tokyo"}';
    await settle(2100);
    expect(env.cardCalls).toHaveLength(2);
    const [shown, next] = frames(env);
    expect(shown).toBe(frame);
    expect(next.getAttribute("src")).toBe(env.cardCalls[1].url);
    expect(next.style.visibility).toBe("hidden");
    expect(frame.style.visibility).not.toBe("hidden");
    expect(frame.style.height).toBe("300px");
    await settle(5000); // a slow load: the old frame stays, and no third page is asked for
    is(frames(env), frame, next);
    expect(env.cardCalls).toHaveLength(2);
    next.dispatchEvent(new Event("load"));
    sized(next, 280); // a size is not it either
    await settle(100);
    expect(frame.isConnected).toBe(true); // loaded (or sized) is not yet ready: the page says so itself
    is(frames(env), frame, next);
    expect(frame.style.height).toBe("300px");
    ready(next);
    await settle(0);
    is(frames(env), next);
    expect(next.style.visibility).not.toBe("hidden");
    expect(next.style.height).toBe("280px"); // the height the new page measured, not a default
  });

  it("the new frame's own height takes over when it is shown, never a default below the old one first", async () => {
    const { env, frame } = await drawn();
    env.data = '{"city":"Tokyo"}';
    await settle(2100);
    const next = frames(env)[1];
    sized(next, 180); // the hidden page measures itself
    await settle(0);
    expect(frame.style.height).toBe("300px"); // the one shown has not changed
    await painted(next);
    is(frames(env), next);
    expect(next.style.height).toBe("180px");
  });
});

describe("a card that needs a new page", () => {
  it("(other picture map) keeps the old iframe until the new one has painted", async () => {
    const { env, frame } = await drawn();
    env.images = { "a.png": "https://asset.invalid/a.png" };
    await settle(2100);
    expect(env.cardCalls).toHaveLength(2);
    expect(frames(env)).toHaveLength(2);
    expect(frames(env)[0]).toBe(frame);
    expect(frame.isConnected).toBe(true);
    await painted(frames(env)[1]);
    expect(frames(env)).toHaveLength(1);
    expect(frames(env)[0]).not.toBe(frame);
  });

  it("drops a page that was asked for data or pictures that are no longer wanted", async () => {
    const env = await open(TEXT);
    env.manual = true;
    await settle(400); // first page asked for, not answered
    expect(env.cardCalls).toHaveLength(1);
    env.images = { "a.png": "https://asset.invalid/a.png" };
    await settle(2100); // the card now needs another page; the first is still pending
    env.cardCalls[0].resolve();
    await settle(10);
    expect(frames(env)).toHaveLength(0); // the stale page is not drawn
    expect(env.cardCalls).toHaveLength(2);
    env.cardCalls[1].resolve();
    await settle(10);
    expect(frames(env).map((f) => f.getAttribute("src"))).toEqual([env.cardCalls[1].url]);
  });

  it("a page that cannot be made leaves the frame shown where it is", async () => {
    const { env, frame } = await drawn();
    env.failCard = true;
    env.images = { "a.png": "https://asset.invalid/a.png" };
    await settle(2100);
    is(frames(env), frame);
    expect(frame.style.display).toBe("block");
    expect(q(env, ".nc-slot").classList.contains("nc-empty")).toBe(false);
  });
});

describe("typing in the note", () => {
  it("keeps the card's frame (the same node, the same height)", async () => {
    const { env, frame } = await drawn();
    const line = [...env.root.querySelectorAll(".nl")].find((el) => el.textContent.includes("intro"));
    line.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    const ta = q(env, ".nl-active textarea");
    ta.value = "intro more";
    ta.setSelectionRange(10, 10);
    ta.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle(0);
    is(frames(env), frame);
    expect(frame.style.height).toBe("300px");
    expect(frame.style.display).toBe("block");
  });
});

describe("the reply of notes.cards", () => {
  it("is matched to the cards of the text it was asked about: lines that moved while it was on its way take nothing from another card", async () => {
    const env = await open(TEXT);
    env.hold = new Promise((ok) => { env.release = ok; });
    await settle(400); // the sync asks the app and waits
    const line = [...env.root.querySelectorAll(".nl")].find((el) => el.textContent.includes("intro"));
    line.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    const ta = q(env, ".nl-active textarea");
    ta.value = "intro\nan extra line"; // the card is one line further down than when it was asked
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle(0);
    env.release();
    await settle(10);
    expect(frames(env)).toHaveLength(1);
    expect(q(env, ".nc-slot").classList.contains("nc-empty")).toBe(false);
  });
});

// The sequences the invariant names: data that comes back, data that moves on, a frame that says it takes live data late.
describe("a card whose data keeps changing", () => {
  const B = '{"city":"Tokyo"}';
  const C = '{"city":"Osaka"}';
  it("a genuinely empty result (the run is done, its data is null) is shown, not kept as stale", async () => {
    const { env, frame } = await drawn();
    announce(frame);
    const posted = vi.spyOn(frame.contentWindow, "postMessage");
    env.status = "done";
    env.data = "null";
    env.handlers.noteCardChanged({ botId: "B1" });
    await settle(200);
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted.mock.calls[0][0]).toEqual({ ccbData: "null" });
  });

  it("data that comes back to what is shown drops the page that was being made for the other", async () => {
    const { env, frame } = await drawn();
    env.data = B;
    await settle(2100);
    expect(frames(env)).toHaveLength(2);
    env.data = null; // the card's own text again
    await settle(2100);
    is(frames(env), frame);
    expect(env.cardCalls).toHaveLength(2);
  });

  it("A, then B, then C: only C's page is waited for; B's page is gone and its late word changes nothing", async () => {
    const { env, frame } = await drawn();
    env.data = B;
    await settle(2100);
    const [, first] = frames(env);
    env.data = C;
    await settle(2100);
    expect(env.cardCalls).toHaveLength(3);
    expect(first.isConnected).toBe(false);
    const list = frames(env);
    expect(list).toHaveLength(2);
    expect(list[0]).toBe(frame);
    expect(list[1].getAttribute("src")).toBe(env.cardCalls[2].url);
    await painted(first); // B's page, gone, says it is ready
    is(frames(env), ...list);
    expect(frame.isConnected).toBe(true);
    await painted(list[1]);
    is(frames(env), list[1]);
  });

  it("the word ready of the shown page hands nothing over: only the page being made can say it is ready", async () => {
    const { env, frame } = await drawn();
    env.data = B;
    await settle(2100);
    const [, next] = frames(env);
    ready(frame);
    await settle(10);
    is(frames(env), frame, next);
  });

  it("the page being made lies over the shown one, as big as it, out of sight and out of reach", async () => {
    const { env, frame } = await drawn();
    env.data = B;
    await settle(2100);
    const [shown, next] = frames(env);
    expect(shown).toBe(frame);
    expect(next.style.display).toBe("block");
    expect(next.style.height).toBe("300px");
    expect(next.style.visibility).toBe("hidden");
    expect(next.style.pointerEvents).toBe("none");
    expect(shown.style.pointerEvents).toBe("");
  });

  it("a page that says (while it is made) it takes live data stays that frame when it is shown: the next data is posted to it", async () => {
    const { env } = await drawn();
    env.data = B;
    await settle(2100);
    const next = frames(env)[1];
    announce(next);
    await painted(next);
    is(frames(env), next);
    const posted = vi.spyOn(next.contentWindow, "postMessage");
    env.data = C;
    await settle(2100);
    expect(env.cardCalls).toHaveLength(2);
    is(frames(env), next);
    expect(posted).toHaveBeenCalledTimes(1);
    expect(JSON.parse(posted.mock.calls[0][0].ccbData)).toEqual({ city: "Osaka" });
  });

  it("a frame that says late that it takes live data: the page being made for it is dropped, the data is posted", async () => {
    const { env, frame } = await drawn();
    env.data = B;
    await settle(2100);
    expect(frames(env)).toHaveLength(2);
    announce(frame);
    const posted = vi.spyOn(frame.contentWindow, "postMessage");
    env.data = C;
    await settle(2100);
    is(frames(env), frame);
    expect(env.cardCalls).toHaveLength(2);
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it("the height a page says it is ready at is the height it is shown at when it sent no size", async () => {
    const { env } = await drawn();
    env.data = B;
    await settle(2100);
    const next = frames(env)[1];
    await painted(next, 220);
    is(frames(env), next);
    expect(next.style.height).toBe("220px");
  });

  it("a page that does not get ready in 10 s is given up: the old one stays, and the page is asked for again", async () => {
    const { env, frame } = await drawn();
    env.data = B;
    env.status = "done"; // no more syncs on their own: only the give-up asks again
    await settle(2100);
    const [, first] = frames(env);
    expect(env.cardCalls).toHaveLength(2);
    await settle(10_100);
    expect(first.isConnected).toBe(false);
    expect(frame.isConnected).toBe(true);
    expect(frame.style.height).toBe("300px");
    expect(env.cardCalls).toHaveLength(3);
    expect(frames(env)).toHaveLength(2);
    expect(frames(env)[0]).toBe(frame);
  });

  it("a card that is gone takes the page being made for it with it", async () => {
    const { env } = await drawn();
    env.data = B;
    await settle(2100);
    expect(frames(env)).toHaveLength(2);
    Object.assign(env, { text: "intro\n", mtime: 7 });
    env.handlers.noteChanged({ botId: "B1", mtime: 7 });
    await settle(10);
    expect(frames(env)).toHaveLength(0);
  });
});

describe("the reply of notes.cards, once more", () => {
  const held = async (text) => {
    const env = await open(text);
    env.hold = new Promise((ok) => { env.release = ok; });
    await settle(400); // the sync asks the app and waits
    return env;
  };
  it("a card whose text changed while the reply was on its way takes nothing from it (its own sync follows)", async () => {
    const env = await held(TEXT);
    Object.assign(env, { text: TEXT.replace("Taipei", "Tokyo"), mtime: 5 });
    env.handlers.noteChanged({ botId: "B1", mtime: 5 });
    await settle(10);
    env.release();
    await settle(10);
    expect(env.cardCalls).toHaveLength(0);
    await settle(600);
    expect(env.cardCalls.map((call) => call.data)).toEqual([{ city: "Tokyo" }]);
  });

  it("a card that is gone takes nothing from it", async () => {
    const env = await held(TEXT);
    Object.assign(env, { text: "intro\n", mtime: 5 });
    env.handlers.noteChanged({ botId: "B1", mtime: 5 });
    await settle(10);
    env.release();
    await settle(600);
    expect(env.cardCalls).toHaveLength(0);
    expect(frames(env)).toHaveLength(0);
  });
});
