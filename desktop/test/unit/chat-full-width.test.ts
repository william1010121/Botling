// The chat's message column fills the chat: the old drag handles on its edges (which sat next to the browser
// pane's divider and fought it) and the saved "messageColumnWidth" are gone. No window, no focus taken.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SettingsChange, SettingsView } from "../../src/contract";
import { settingsView } from "../../src/core/settings";
import { editorMessageAllowed } from "../../src/editor-host-wire";

const frameCss = readFileSync("src/renderer/chat-frame/frame.css", "utf8");
const entry = readFileSync("src/renderer/chat-frame/entry.ts", "utf8");

describe("chat message column fills the chat", () => {
  it("has no width handles and no width cap", () => {
    expect(frameCss).not.toMatch(/message-width-handle|--message-column-width/);
    expect(entry).not.toMatch(/message-width|installMessageWidth/);
    const rule = frameCss.match(/#messages, body\.watching #messages, body:not\(\.board\) #composer-slot, #pin-area \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("width: 100%");
    expect(rule).toContain("max-width: none");
  });
  it("an old saved width is ignored and can no longer be set", () => {
    const view = settingsView({ messageColumnWidth: 420 });
    expect(view).not.toHaveProperty("messageColumnWidth");
    expect(SettingsView.safeParse(view).success).toBe(true);
    expect(SettingsChange.safeParse({ key: "messageColumnWidth", value: 800 }).success).toBe(false);
  });
  it("the chat page cannot send width messages to the app any more", () => {
    expect(editorMessageAllowed("up", { botling: "messageWidth", value: 640 })).toBe(false);
    expect(editorMessageAllowed("up", { botling: "messageWidthDrag", active: true })).toBe(false);
    expect(editorMessageAllowed("down", { botling: "widthPreview", value: 640 })).toBe(false);
  });
});
