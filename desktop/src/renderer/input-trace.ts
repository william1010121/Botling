import type { TestTraceRecord } from "../test-trace";

export interface InputTrace {
  mark(event: string, data?: () => Record<string, unknown>): string | undefined;
  node(target: EventTarget | null): unknown;
  snapshot(): Record<string, unknown>;
}
let current: InputTrace | undefined;
export const inputTrace = () => current;
export const setInputTrace = (trace: InputTrace | undefined) => { current = trace; };

/** Only called after the test capability/query opt-in. Does not focus, mutate, poll, or log to console. */
export function createInputTrace(
  scope: TestTraceRecord["scope"], win: Window,
  sink: (record: TestTraceRecord) => void,
  editor: () => Record<string, unknown> = () => ({}),
): InputTrace {
  const timeOrigin = win.performance.timeOrigin;
  const generation = `${scope}:${timeOrigin}`;
  let seq = 0, nextNode = 0;
  const nodes = new WeakMap<object, number>();
  const node = (target: EventTarget | null): unknown => {
    if (!target || typeof target !== "object") return null;
    if (target === win) return { window: true };
    if (!nodes.has(target)) nodes.set(target, ++nextNode);
    const element = target as Element;
    return { node: nodes.get(target), tag: element.nodeName, id: element.id || undefined,
      classes: typeof element.className === "string" ? element.className : undefined };
  };
  const snapshot = () => ({ activeElement: node(win.document.activeElement), hasFocus: win.document.hasFocus(), ...editor() });
  const trace: InputTrace = {
    node, snapshot,
    mark(event, data = () => ({})) {
      // A diagnostic sink must never throw into an input handler or alter its result.
      try {
        const n = ++seq;
        sink({ v: 1, scope, generation, timeOrigin, at: timeOrigin + win.performance.now(), seq: n, event, data: data() });
        return `${generation}/${n}`;
      } catch { return undefined; }
    },
  };
  return trace;
}

/** Capture first, then observe final flags in a microtask even if another handler stops propagation. */
export function traceDocumentEvents(trace: InputTrace, win: Window): void {
  for (const type of ["keydown", "keypress", "keyup", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend",
    "focus", "blur", "focusin", "focusout", "pointerdown", "visibilitychange"]) {
    win.addEventListener(type, event => {
      const fields = () => {
        const key = event as KeyboardEvent;
        const input = event as InputEvent;
        return { target: trace.node(event.target), relatedTarget: trace.node((event as FocusEvent).relatedTarget),
          isTrusted: event.isTrusted, defaultPrevented: event.defaultPrevented,
          key: key.key, code: key.code, keyCode: key.keyCode, isComposing: key.isComposing,
          metaKey: key.metaKey, ctrlKey: key.ctrlKey, altKey: key.altKey, shiftKey: key.shiftKey,
          inputType: input.inputType, data: typeof input.data === "string" ? input.data.slice(0, 8192) : input.data,
          ...trace.snapshot() };
      };
      const cause = trace.mark(`dom.${type}`, fields);
      win.queueMicrotask(() => trace.mark(`dom.${type}.after`, () => ({ cause, ...fields() })));
    }, true);
  }
}
