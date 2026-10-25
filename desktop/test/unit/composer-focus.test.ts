import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Input = Record<string, any>;
type Handler = (event: Input) => void;
let frameListeners: Record<string, Handler[]>;
let documentListeners: Record<string, Handler[]>;
let doc: Input;
let win: Input;
let mutation: () => void;
let view: ReturnType<typeof editor> | null;
let announcements: Input[];
let recover: () => boolean;
let hasFocus: boolean;
let focusCalls: number;
let syntheticKeys: string[];
let submitCount: number;

const input = (type: string, fields: Input = {}): Input => ({
  type, key: "", code: "", keyCode: 0, isComposing: false, isTrusted: true,
  metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
  defaultPrevented: false, stopped: false,
  preventDefault() { this.defaultPrevented = true; },
  stopImmediatePropagation() { this.stopped = true; }, ...fields,
});
function listen(listeners: Record<string, Handler[]>, type: string, fn: Handler) {
  (listeners[type] ??= []).push(fn);
}
function send(type: string, fields: Input = {}) {
  const event = input(type, { target: doc.activeElement, ...fields });
  // Model capture order only. There is deliberately no simulated browser default insertion or
  // native focus routing: the tests check recovery's own dispatches and CodeMirror transactions.
  for (const listeners of [frameListeners, documentListeners]) {
    for (const handler of listeners[type] ?? []) {
      handler(event);
      if (event.stopped) return event;
    }
  }
  return event;
}
function element(composer = false): Input {
  const el: Input = { ownerDocument: doc, isConnected: true };
  el.closest = () => composer ? el : null;
  el.contains = (other: Input) => other === el;
  return el;
}
function editor(text = "") {
  const contentDOM = element(true);
  const result = {
    contentDOM, composing: false, state: EditorState.create({ doc: text, selection: { anchor: text.length } }),
    dispatch(...specs: TransactionSpec[]) { result.state = result.state.update(...specs).state; },
    focus() {
      focusCalls++;
      doc.activeElement = contentDOM;
      send("focusin", { target: contentDOM });
    },
  };
  contentDOM.dispatchEvent = (event: Input) => {
    syntheticKeys.push(event.key);
    const captured = send(event.type, event);
    if (!captured.stopped && !captured.defaultPrevented && event.key === "Enter") {
      submitCount++; event.preventDefault();
    }
    return !event.defaultPrevented;
  };
  return result;
}
function bodyKey(key: string, fields: Input = {}) {
  const down = send("keydown", { key, ...fields });
  return down.stopped || down.defaultPrevented ? down : send("keypress", { key, ...fields });
}
function typeAtBody(text: string) { for (const key of text) bodyKey(key); }
function insert(text: string) { view!.dispatch(view!.state.replaceSelection(text)); }
function lose() {
  doc.activeElement = doc.body;
  send("focusout", { target: view!.contentDOM, relatedTarget: null });
}

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(10_000);
  frameListeners = {}; documentListeners = {}; announcements = [];
  hasFocus = true; focusCalls = 0; syntheticKeys = []; submitCount = 0;
  doc = {
    body: {}, documentElement: { dataset: { chat: "main" } }, hasFocus: () => hasFocus,
    addEventListener: (type: string, fn: Handler) => listen(documentListeners, type, fn),
  };
  doc.activeElement = doc.body;
  win = { document: doc, addEventListener: (type: string, fn: Handler) => listen(frameListeners, type, fn) };
  doc.defaultView = win;
  vi.stubGlobal("document", doc); vi.stubGlobal("window", win);
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: () => void) { mutation = callback; }
    observe() {}
  });
  vi.stubGlobal("KeyboardEvent", class {
    constructor(type: string, fields: Input) { Object.assign(this, input(type, { ...fields, isTrusted: false })); }
  });
  view = editor();
  const { installInputRecovery } = await import("../../src/renderer/chat-frame/input-focus");
  const { installImeGuard } = await import("../../../Web/src/ime");
  installImeGuard(win as Window);
  recover = installInputRecovery(() => view as unknown as EditorView | null, message => announcements.push(message));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("applies body text before later editor transactions without replaying printable keydown", () => {
  bodyKey("P");
  // After recovery the remaining text uses editor transactions, outside the body fallback.
  insert("refix ab");
  view!.dispatch({ selection: { anchor: view!.state.selection.main.head - 1 } });
  insert("X");
  expect(view!.state.doc.toString()).toBe("Prefix aXb");
  expect(syntheticKeys).toEqual([]);
});

it("opens recovery at a silent editor replacement after the initial three seconds", () => {
  view!.focus(); vi.advanceTimersByTime(3_200);
  view = editor("draft"); doc.activeElement = doc.body;
  mutation();
  expect(doc.activeElement).toBe(view.contentDOM);
  expect(view.state.doc.toString()).toBe("draft");
  expect(announcements.some(message => message.recoveryUntil === 16_200)).toBe(true);
});

it("keeps body text in order while no editor exists, then flushes before subsequent edits", () => {
  view!.focus(); lose(); view = null; mutation();
  typeAtBody("Prefix ");
  view = editor(); mutation(); insert("ab");
  view.dispatch({ selection: { anchor: view.state.selection.main.head - 1 } }); insert("X");
  expect(view.state.doc.toString()).toBe("Prefix aXb");
  expect(syntheticKeys).toEqual([]);
});

it("does not give one continuous loss an unlimited recovery window", () => {
  view!.focus(); lose(); vi.advanceTimersByTime(3_000);
  const calls = focusCalls;
  mutation(); typeAtBody("x");
  expect(recover()).toBe(false);
  expect(focusCalls).toBe(calls);
  expect(view!.state.doc.toString()).toBe("");
});

it.each(["Tab", "Escape"])("keeps %s focus intent authoritative over body recovery", key => {
  view!.focus(); lose();
  const event = send("keydown", { key });
  mutation(); typeAtBody("x");
  expect(event.defaultPrevented).toBe(false);
  expect(recover()).toBe(false);
  expect(view!.state.doc.toString()).toBe("");
});

it("leaves a feedback field's input alone and does not recover after that explicit field choice", () => {
  const feedback = element(); doc.activeElement = feedback;
  send("focusin", { target: feedback });
  const press = bodyKey("x");
  expect(press.defaultPrevented).toBe(false);
  doc.activeElement = doc.body; mutation(); bodyKey("y");
  expect(focusCalls).toBe(0);
  expect(view!.state.doc.toString()).toBe("");
});

it.each(["metaKey", "ctrlKey", "altKey"])("never redispatches a %s shortcut", modifier => {
  let pluginCalls = 0;
  listen(frameListeners, "keydown", () => { pluginCalls++; });
  send("keydown", { key: "M", shiftKey: true, [modifier]: true });
  expect(pluginCalls).toBe(1);
  expect(syntheticKeys).toEqual([]);
  expect(focusCalls).toBe(0);
});

it("honors a prevented original Return before attempting recovery", () => {
  const event = send("keydown", { key: "Enter", defaultPrevented: true });
  expect(event.defaultPrevented).toBe(true);
  expect(syntheticKeys).toEqual([]);
  expect(focusCalls).toBe(0);
  expect(submitCount).toBe(0);
});

it("handles a frame-body Return once when its editor can regain focus", () => {
  insert("ready to send");
  const event = send("keydown", { key: "Enter", code: "Enter" });
  expect(submitCount).toBe(1);
  expect(syntheticKeys).toEqual(["Enter"]);
  expect(event.defaultPrevented).toBe(true);
});

it("does not recover an unfocused document just because it received a Return callback", () => {
  hasFocus = false;
  const event = send("keydown", { key: "Enter" });
  expect(event.defaultPrevented).toBe(false);
  expect(focusCalls).toBe(0);
  expect(submitCount).toBe(0);
});

it.each(["state", "isComposing", "229", "ended"].flatMap(mode => [" ", "Enter"].map(key => [mode, key])))
("never buffers or replays an IME-owned body key (%s, %j)", (mode, key) => {
  if (mode === "state") send("compositionstart", { target: view!.contentDOM });
  if (mode === "ended") send("compositionend");
  const fields = mode === "isComposing" ? { isComposing: true } : mode === "229" ? { keyCode: 229 } : {};
  bodyKey(key, { code: key === "Enter" ? "Enter" : "Space", ...fields });
  expect(view!.state.doc.toString()).toBe("");
  expect(syntheticKeys).toEqual([]);
  expect(submitCount).toBe(0);
  expect(focusCalls).toBe(0);
});

it("never buffers text from an untrusted keypress", () => {
  send("keypress", { key: "x", isTrusted: false });
  expect(view!.state.doc.toString()).toBe("");
  expect(focusCalls).toBe(0);
});

it("associates text typed before the first chat state with the first available editor", () => {
  delete doc.documentElement.dataset.chat;
  view = null; mutation(); typeAtBody("early ");
  doc.documentElement.dataset.chat = "main";
  view = editor(); mutation();
  expect(view.state.doc.toString()).toBe("early ");
});

it("keeps a missing editor's buffered text with its chat rather than a different chat", () => {
  view!.focus(); lose(); view = null; mutation(); typeAtBody("main draft");
  doc.documentElement.dataset.chat = "other";
  view = editor("other draft"); mutation();
  expect(view.state.doc.toString()).toBe("other draft");
  doc.documentElement.dataset.chat = "main";
  view = editor(); doc.activeElement = doc.body; mutation();
  expect(view.state.doc.toString()).toBe("main draft");
});

it("also leaves body input alone while CodeMirror reports native composition", () => {
  view!.composing = true;
  bodyKey(" "); send("keydown", { key: "Enter" });
  expect(view!.state.doc.toString()).toBe("");
  expect(syntheticKeys).toEqual([]);
  expect(focusCalls).toBe(0);
});
