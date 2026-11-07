// A video in a chat message (Web/src/markdown.ts `<video controls>`) lives in the chat frame, a cross-origin
// iframe (botling-chat://chat) in the app page. Its fullscreen button only works when the frame's `allow`
// grants fullscreen and the session's permission handlers (main.ts `hardenSession`) let the app's own pages
// have it. Before this fix both refused, so the button did nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { permissionAllowed } from "../../src/main/permissions";
import { CHAT_FRAME_ALLOW } from "../../src/renderer/chat-frame/protocol";
import { desktop } from "../helpers";

const policy = (allow: string | undefined) => (allow ?? "").split(";").map(part => part.trim().split(/\s+/)[0]);

describe("chat video fullscreen", () => {
  it("the chat frame's permissions policy grants fullscreen, on the main chat and on takeover pages", () => {
    expect(policy(CHAT_FRAME_ALLOW)).toContain("fullscreen");
    for (const file of ["src/renderer/App.tsx", "src/renderer/TakeoverPage.tsx"]) {
      const source = readFileSync(join(desktop, file), "utf8");
      const frames = source.match(/<iframe[^>]*CHAT_PAGE[^>]*>/g) ?? [];
      expect(frames.length, file).toBeGreaterThan(0);
      for (const frame of frames) expect(frame, file).toContain("allow={CHAT_FRAME_ALLOW}");
    }
  });

  it("the session grants fullscreen to the app's own pages", () => {
    for (const requestingUrl of ["botling-chat://chat/chat.html", "botling-chat://chat", "app://botling/index.html", "app://botling"]) {
      expect(permissionAllowed({ permission: "fullscreen", owned: true, requestingUrl }), requestingUrl).toBe(true);
    }
  });

  it("the session counts the native chat view (where the main chat's videos are) as the app's own", () => {
    const main = readFileSync(join(desktop, "src/main/main.ts"), "utf8");
    const handlers = main.slice(main.indexOf("function hardenSession"), main.indexOf("will-download"));
    expect(handlers.match(/owned: ownedContents\(contents\)/g) ?? []).toHaveLength(2);
    expect(main).toMatch(/const ownedContents = [^\n]*appContents\.has\([^\n]*isNativeEditorHost\(/);
  });

  it("everything else stays refused", () => {
    const ok = { permission: "fullscreen", owned: true, requestingUrl: "botling-chat://chat/chat.html" };
    for (const change of [{ owned: false }, { requestingUrl: "botling-card://page/1" }, { requestingUrl: "https://example.com/" },
      { requestingUrl: "botling-chat://chat.evil/" }, { requestingUrl: "app://botling.evil/" }, { requestingUrl: "" },
      { permission: "media" }, { permission: "notifications" }, { permission: "clipboard-read" }, { permission: "pointerLock" }]) {
      expect(permissionAllowed({ ...ok, ...change }), JSON.stringify(change)).toBe(false);
    }
  });
});
