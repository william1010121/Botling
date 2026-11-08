// @vitest-environment jsdom
// Navigation v5: in the native chat, ⌘[ / ⌘] and ⌘⌥1–9 go to the shell as commands and never reach the editor.
import { expect, it } from "vitest";

it("turns ⌘[ / ⌘] / ⌘⌥2 into shell commands the editor never sees, leaving the typed draft alone", async () => {
  const posted: unknown[] = [];
  (window as unknown as { botlingEditor: unknown }).botlingEditor = { post: (message: unknown) => { posted.push(message); return true; }, subscribe: () => () => {}, current: () => null };
  const { installNativeShellCommands } = await import("../../src/renderer/chat-frame/transport");
  installNativeShellCommands();
  document.body.innerHTML = "<textarea>half a thought</textarea>";
  const box = document.querySelector("textarea")!;
  const press = (init: KeyboardEventInit) => { const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }); box.dispatchEvent(event); return event; };
  const mod = navigator.platform.includes("Mac") ? { metaKey: true } : { ctrlKey: true };
  expect(press({ key: "[", code: "BracketLeft", ...mod }).defaultPrevented).toBe(true);
  expect(press({ key: "]", code: "BracketRight", ...mod }).defaultPrevented).toBe(true);
  expect(press({ key: "™", code: "Digit2", altKey: true, ...mod }).defaultPrevented).toBe(true);
  expect(posted).toEqual(["roomBack", "roomForward", "pinnedSubBot2"].map((command) => ({ botling: "action", action: { type: "shellCommand", command } })));
  expect(box.value).toBe("half a thought");
});
