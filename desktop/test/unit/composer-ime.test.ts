import { afterEach, beforeEach, expect, it, vi } from "vitest";

type InputEvent = Record<string, any>;
let listeners: Record<string, ((event: InputEvent) => void)[]>;
let win: Record<string, any>;
let owns: (event: KeyboardEvent) => boolean;
const event = (type: string, fields: Record<string, any> = {}) => ({
  type, key: "", code: "", keyCode: 0, isComposing: false, target: null, prevented: false, stopped: false,
  preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...fields,
});
function dispatch(input: InputEvent) {
  for (const listener of listeners[input.type] ?? []) { listener(input); if (input.stopped) break; }
  return input;
}
beforeEach(async () => {
  vi.resetModules(); listeners = {};
  win = { document: { activeElement: null }, addEventListener(type: string, listener: (event: InputEvent) => void) {
    (listeners[type] ??= []).push(listener);
  } };
  vi.stubGlobal("window", win);
  ({ imeOwnsKey: owns } = await import("../../src/renderer/chat-frame/input-ime"));
  const { installImeGuard } = await import("../../../Web/src/ime");
  installImeGuard(win as Window);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("retains candidate Return ownership through an unflagged native keypress after grace", () => {
  vi.useFakeTimers();
  dispatch(event("keydown", { key: "Enter", code: "Enter", keyCode: 229 }));
  vi.advanceTimersByTime(150);
  const press = dispatch(event("keypress", { key: "Enter", code: "Enter", keyCode: 13 }));
  expect(press.prevented).toBe(true); expect(press.stopped).toBe(true);
  dispatch(event("keyup", { key: "Enter" }));
  dispatch(event("keydown", { key: "Enter", code: "Enter", keyCode: 13 }));
  expect(dispatch(event("keypress", { key: "Enter", code: "Enter", keyCode: 13 })).prevented).toBe(false);
});
it("retains composing Space ownership when the shared guard clears its stale state", () => {
  const editor = { isConnected: true, contains: () => true };
  win.document.activeElement = editor;
  dispatch(event("compositionstart", { target: editor }));
  dispatch(event("keydown", { key: " ", code: "Space", keyCode: 32 }));
  expect(win.__ccbIme.composing).toBe(false);
  expect(owns(event("keypress", { key: " ", keyCode: 32 }) as unknown as KeyboardEvent)).toBe(true);
});
it.each([{ isComposing: true }, { keyCode: 229 }])("never offers an IME-owned native key to body text recovery (%j)", fields => {
  dispatch(event("keydown", { key: " ", ...fields }));
  expect(owns(event("keypress", { key: " ", keyCode: 32 }) as unknown as KeyboardEvent)).toBe(true);
  dispatch(event("keyup"));
  expect(owns(event("keypress", { key: "a", keyCode: 65 }) as unknown as KeyboardEvent)).toBe(false);
});
it("keeps the composition-end grace for body text without claiming a later ordinary character", () => {
  vi.useFakeTimers(); dispatch(event("compositionend"));
  expect(owns(event("keypress", { key: " ", keyCode: 32 }) as unknown as KeyboardEvent)).toBe(true);
  vi.advanceTimersByTime(150);
  expect(owns(event("keypress", { key: "a", keyCode: 65 }) as unknown as KeyboardEvent)).toBe(false);
});
