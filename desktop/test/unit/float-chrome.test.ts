// @vitest-environment jsdom
// The floating chat's header and grip as the chat page draws them (chat-frame/float-chrome.ts): shown only while the
// shell floats or docks the chat, its buttons and drags told to the shell, Esc folding it to the strip.
import { afterEach, expect, it } from "vitest";
import { mountFloatChrome } from "../../src/renderer/chat-frame/float-chrome";
import type { FloatChromeSpec, FrameMessage } from "../../src/renderer/chat-frame/protocol";

const spec: FloatChromeSpec = { name: "botling", status: "Writing…", tone: "working", face: null, docked: false };
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; });

function mount(running = false) {
  const sent: FrameMessage[] = [];
  const chrome = mountFloatChrome(document.body, (message) => sent.push(message), () => running);
  dispose = chrome.dispose;
  return { chrome, sent };
}
const pointer = (type: string, x: number, y: number) => {
  const event = new MouseEvent(type, { bubbles: true, button: 0, screenX: x, screenY: y }) as MouseEvent & { pointerId: number };
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
};

it("draws nothing until the shell floats the chat, and goes away again", () => {
  const { chrome } = mount();
  expect(document.querySelector(".float-chrome")).toBeNull();
  chrome.show(spec);
  expect(document.body.firstElementChild?.className).toBe("float-chrome");
  expect(document.querySelector(".float-name")?.textContent).toBe("botling");
  expect(document.querySelector<HTMLElement>(".float-status")?.dataset.tone).toBe("working");
  expect(document.querySelector<HTMLElement>(".float-grip")?.hidden).toBe(false);
  expect(document.body.classList.contains("floating-chat")).toBe(true);
  chrome.show(null);
  expect(document.querySelector(".float-chrome")).toBeNull();
  expect(document.querySelector(".float-grip")).toBeNull();
  expect(document.body.classList.contains("floating-chat")).toBe(false);
});

it("its buttons dock, float and collapse; docked, the grip hides and the button floats it again", () => {
  const { chrome, sent } = mount();
  chrome.show(spec);
  document.querySelector<HTMLButtonElement>(".float-dock")!.click();
  document.querySelector<HTMLButtonElement>(".float-collapse")!.click();
  chrome.show({ ...spec, docked: true });
  expect(document.querySelector<HTMLElement>(".float-grip")!.hidden).toBe(true);
  expect(document.querySelector(".float-dock")?.getAttribute("aria-label")).toBe("Float the chat over the page");
  document.querySelector<HTMLButtonElement>(".float-dock")!.click();
  expect(sent).toEqual([{ botling: "floatAct", act: "dock" }, { botling: "floatAct", act: "collapse" }, { botling: "floatAct", act: "float" }]);
});

it("dragging the header says how far the pointer went since it started", () => {
  const { chrome, sent } = mount();
  chrome.show(spec);
  const header = document.querySelector<HTMLElement>(".float-chrome")!;
  header.setPointerCapture = () => {};
  header.dispatchEvent(pointer("pointerdown", 100, 100));
  header.dispatchEvent(pointer("pointerup", 160, 70));
  expect(sent).toEqual([
    { botling: "floatDrag", kind: "move", phase: "start", dx: 0, dy: 0 },
    { botling: "floatDrag", kind: "move", phase: "end", dx: 60, dy: -30 },
  ]);
  const grip = document.querySelector<HTMLElement>(".float-grip")!;
  grip.setPointerCapture = () => {};
  sent.length = 0;
  grip.dispatchEvent(pointer("pointerdown", 10, 10));
  grip.dispatchEvent(pointer("pointerup", 50, 30));
  expect(sent.map((m) => m.botling === "floatDrag" && `${m.kind}/${m.phase}/${m.dx},${m.dy}`)).toEqual(["resize/start/0,0", "resize/end/40,20"]);
});

it("Esc collapses it, but not while a reply is written (Esc twice stops that)", () => {
  const idle = mount(false);
  idle.chrome.show(spec);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(idle.sent).toEqual([{ botling: "floatAct", act: "collapse" }]);
  dispose();
  const busy = mount(true);
  busy.chrome.show(spec);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(busy.sent).toEqual([]);
});
