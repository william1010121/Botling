import { EditorState, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isTestTraceRecord, TEST_TRACE_MAX_BYTES, type TestTraceRecord } from "../../src/test-trace";
import { createInputTrace, setInputTrace, traceDocumentEvents } from "../../src/renderer/input-trace";
import { editorTraceSnapshot, traceEditorView } from "../../src/renderer/chat-frame/input-trace-editor";
let records: TestTraceRecord[];
let handlers: Record<string, ((event: any) => void)[]>;
let microtasks: (() => void)[];
let fakeWindow: Window;
beforeEach(() => {
  records = []; handlers = {}; microtasks = [];
  let tick = 0;
  fakeWindow = {
    performance: { timeOrigin: 123_000, now: () => ++tick / 10 },
    document: { activeElement: { nodeName: "BODY" }, hasFocus: () => false },
    queueMicrotask: (fn: () => void) => microtasks.push(fn),
    addEventListener: (type: string, fn: (event: any) => void) => (handlers[type] ??= []).push(fn),
  } as unknown as Window;
});
afterEach(() => { setInputTrace(undefined); vi.unstubAllGlobals(); });
const makeTrace = () => createInputTrace("chat", fakeWindow, record => records.push(record));
it("uses epoch time, per-document generation and sequence independently of sink arrival time", () => {
  const trace = makeTrace();
  const first = trace.mark("one"); const second = trace.mark("two");
  expect(records.map(r => [r.generation, r.seq, r.at])).toEqual([
    ["chat:123000", 1, 123000.1], ["chat:123000", 2, 123000.2],
  ]);
  expect(first).toBe("chat:123000/1"); expect(second).toBe("chat:123000/2");
});
it("retains final prevention/IME flags even when the original event cannot bubble", () => {
  traceDocumentEvents(makeTrace(), fakeWindow);
  const event = { target: fakeWindow.document.activeElement, key: "Enter", code: "Enter", keyCode: 229,
    isComposing: true, isTrusted: true, defaultPrevented: false };
  handlers.keydown[0](event); event.defaultPrevented = true;
  microtasks.splice(0).forEach(task => task());
  expect(records[0]).toMatchObject({ event: "dom.keydown", data: { defaultPrevented: false, hasFocus: false, keyCode: 229, isComposing: true } });
  expect(records[1]).toMatchObject({ event: "dom.keydown.after", data: {
    cause: "chat:123000/1", defaultPrevented: true, isTrusted: true, key: "Enter", hasFocus: false,
  } });
});
it("does not prevent or stop input while observing it", () => {
  traceDocumentEvents(makeTrace(), fakeWindow);
  const event = { preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
  handlers.beforeinput[0](event); microtasks.splice(0).forEach(task => task());
  expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
});
it("gives the same DOM node a stable local id across capture and later records", () => {
  const trace = makeTrace(); const target = {} as EventTarget;
  expect(trace.node(target)).toEqual(trace.node(target));
  expect(trace.node({} as EventTarget)).not.toEqual(trace.node(target));
});
it("never lets a broken diagnostic sink or snapshot throw into input handlers", () => {
  const trace = createInputTrace("chat", fakeWindow, () => { throw new Error("sink closed"); });
  expect(() => trace.mark("closed")).not.toThrow();
  expect(() => trace.mark("bad snapshot", () => { throw new Error("gone"); })).not.toThrow();
});
it("does not read document/input data or install handlers without the shell capability", async () => {
  vi.stubGlobal("window", { __botlingTestTrace: undefined, addEventListener: vi.fn() });
  const read = vi.fn(() => { throw new Error("must not read user text"); });
  vi.stubGlobal("document", { get activeElement() { return read(); } });
  vi.stubGlobal("location", { search: "?__botling_test_trace=1" });
  await import("../../src/renderer/input-trace-shell");
  expect(read).not.toHaveBeenCalled(); expect(window.addEventListener).not.toHaveBeenCalled();
});
it("records unread DOM before a programmatic transaction without flushing or injecting transactions", () => {
  const trace = makeTrace(); let dom = "ea"; const flush = vi.fn();
  const view = {
    state: EditorState.create({ doc: "e" }), composing: false, observer: { flush },
    contentDOM: { querySelectorAll: () => [{ textContent: dom }] },
    dispatch(...args: any[]) { this.update([this.state.update(...args)]); },
    update(transactions: readonly Transaction[]) { this.state = transactions.at(-1)!.state; dom = this.state.doc.toString(); },
  };
  const editor = view as unknown as EditorView;
  traceEditorView(trace, editor); traceEditorView(trace, editor);
  expect(records.map(r => r.event)).toEqual(["editor.observe"]);
  view.dispatch({ changes: { from: 0, to: 1, insert: "e" }, userEvent: "input.type", annotations: Transaction.remote.of(true) });
  expect(records.find(r => r.event === "editor.dispatch.before")?.data).toMatchObject({ cmDoc: "e", domDoc: "ea" });
  expect(records.find(r => r.event === "editor.transactions")?.data.transactions).toEqual([
    expect.objectContaining({ userEvent: "input.type", remote: true, startDoc: "e", doc: "e" }),
  ]);
  expect(records.find(r => r.event === "editor.dispatch.after")?.data).toMatchObject({ cmDoc: "e", domDoc: "e" });
  expect(flush).not.toHaveBeenCalled(); expect(view.state.doc.toString()).toBe("e");
});
it("preserves a dispatch error rather than swallowing it with tracing", () => {
  const view = { state: EditorState.create(), composing: false,
    contentDOM: { querySelectorAll: () => [] }, dispatch() { throw new Error("original failure"); }, update() {} };
  traceEditorView(makeTrace(), view as unknown as EditorView);
  expect(() => view.dispatch()).toThrow("original failure");
  expect(records.at(-1)).toMatchObject({ event: "editor.dispatch.after", data: { completed: false } });
});
it("bounds editor text but records original lengths so clipping is visible", () => {
  const text = "a".repeat(9000);
  const snapshot = editorTraceSnapshot({ state: EditorState.create({ doc: text }), composing: false,
    contentDOM: { textContent: text, querySelectorAll: () => [{ textContent: text }] } } as unknown as EditorView);
  expect(snapshot).toMatchObject({ cmLength: 9000, domLength: 9000, domTextContentLength: 9000, domTextContent: text.slice(0, 8192), cmDoc: text.slice(0, 8192), domDoc: text.slice(0, 8192) });
});
it("accepts bounded records and rejects malformed, cyclic or oversized IPC input", () => {
  makeTrace().mark("fixture"); const valid = records[0];
  expect(isTestTraceRecord(valid)).toBe(true);
  for (const bad of [{ ...valid, at: NaN }, { ...valid, seq: 0 }, { ...valid, scope: "card" }, { ...valid, data: [] },
    { ...valid, data: { text: "中".repeat(TEST_TRACE_MAX_BYTES) } }]) expect(isTestTraceRecord(bad)).toBe(false);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  expect(isTestTraceRecord({ ...valid, data: cycle })).toBe(false);
});

it("relays only validated chat records from the current chat frame at the expected origin", async () => {
  vi.resetModules();
  const emit = vi.fn(); const currentFrame = {};
  const shellWindow = fakeWindow as Window & { __botlingTestTrace?: unknown };
  shellWindow.__botlingTestTrace = { protocol: 1, emit };
  vi.stubGlobal("window", shellWindow);
  vi.stubGlobal("location", { origin: "app://botling" });
  vi.stubGlobal("document", { getElementById: () => ({ contentWindow: currentFrame }) });
  await import("../../src/renderer/input-trace-shell");
  emit.mockClear();
  makeTrace().mark("chat.fixture");
  const record = records[0];
  const good = { source: currentFrame, origin: "botling-chat://chat", data: { botling: "testTrace", record } };
  const receive = handlers.message[0];
  receive({ ...good, source: {} });
  receive({ ...good, origin: "botling-card://page" });
  receive({ ...good, data: { botling: "testTrace", record: { ...record, scope: "shell" } } });
  receive({ ...good, data: { botling: "testTrace", record: { broken: true } } });
  expect(emit).not.toHaveBeenCalled();
  receive(good);
  expect(emit).toHaveBeenCalledExactlyOnceWith(record);
});
