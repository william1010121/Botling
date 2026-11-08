// @vitest-environment jsdom
// A single Escape used to stop the reply being written, and people hit it by accident (closing a menu,
// leaving an edit). Now it takes two presses of Escape close together; the first says "press again".
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ESCAPE_STOP_WINDOW_MS, installEscapeStop, overlayOpen } from "../../src/renderer/chat-frame/escape-stop";

let stops = 0;
let running = true;
let remove: () => void = () => undefined;

function press(init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}
const hint = () => document.querySelector<HTMLElement>(".escape-stop-hint");

beforeEach(() => {
  vi.useFakeTimers();
  stops = 0; running = true;
  document.body.innerHTML = "";
  remove = installEscapeStop({ running: () => running, stop: () => { stops++; }, words: () => "Press Esc again to stop" });
});
afterEach(() => { remove(); vi.useRealTimers(); });

it("a single Escape does not stop the reply; it shows a hint that fades after the window", () => {
  press();
  expect(stops).toBe(0);
  expect(hint()?.classList.contains("shown")).toBe(true);
  expect(hint()?.textContent).toBe("Press Esc again to stop");
  vi.advanceTimersByTime(ESCAPE_STOP_WINDOW_MS + 1);
  expect(hint()?.classList.contains("shown")).toBe(false);
  expect(stops).toBe(0);
});

it("two Escapes within the window stop it once", () => {
  press();
  vi.advanceTimersByTime(ESCAPE_STOP_WINDOW_MS - 100);
  press();
  expect(stops).toBe(1);
  expect(hint()?.classList.contains("shown")).toBe(false);
  // A third press starts over.
  press();
  expect(stops).toBe(1);
});

it("two Escapes further apart than the window do not stop it", () => {
  press();
  vi.advanceTimersByTime(ESCAPE_STOP_WINDOW_MS + 50);
  press();
  expect(stops).toBe(0);
  vi.advanceTimersByTime(100);
  press();
  expect(stops).toBe(1);
});

it("nothing happens while no reply is being written", () => {
  running = false;
  press(); press();
  expect(stops).toBe(0);
  expect(hint()?.classList.contains("shown") ?? false).toBe(false);
});

it("an Escape another part used (closing a menu, a list, an edit) does not count toward the pair", () => {
  // Handled and marked so (preventDefault), as the mention list and model popover do.
  const field = document.body.appendChild(document.createElement("div"));
  field.addEventListener("keydown", (event) => event.preventDefault());
  press();
  press({}, field);
  press();
  expect(stops).toBe(0);
  vi.advanceTimersByTime(ESCAPE_STOP_WINDOW_MS + 1);
  // A menu open when Escape came (it closes itself without marking the key) does not count either,
  // and breaks a pair already started.
  press();
  const menu = document.body.appendChild(document.createElement("div"));
  menu.setAttribute("role", "menu");
  document.addEventListener("keydown", () => menu.remove(), { capture: true, once: true });
  press();
  expect(stops).toBe(0);
  press();
  expect(stops).toBe(0);
  press();
  expect(stops).toBe(1);
});

it("held-down repeats, IME composition and modified Escapes do not count", () => {
  press();
  press({ repeat: true });
  press({ isComposing: true });
  press({ shiftKey: true });
  expect(stops).toBe(0);
});

it("knows open menus, dialogs and lists, and ignores hidden ones", () => {
  expect(overlayOpen()).toBe(false);
  const holder = document.body.appendChild(document.createElement("div"));
  holder.hidden = true;
  holder.appendChild(document.createElement("div")).setAttribute("role", "listbox");
  expect(overlayOpen()).toBe(false);
  holder.hidden = false;
  expect(overlayOpen()).toBe(true);
  holder.remove();
  const dialog = document.body.appendChild(document.createElement("dialog"));
  expect(overlayOpen()).toBe(false);
  dialog.setAttribute("open", "");
  expect(overlayOpen()).toBe(true);
});
