// A bot's face for plugins (core/faces.ts, `workspace.face`): what the app draws, as a data URL.
import { describe, expect, it } from "vitest";
import { botFace } from "../../src/core/faces";
import { avatarURL } from "../../src/renderer/avatars";

const decode = (url: string) => Buffer.from(url.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");

describe("botFace", () => {
  it("draws the original look as the app does: its shape, eyes closed while asleep", () => {
    expect(botFace({ avatar: "star", heads: ["claude"] }, "original", { asleep: false, working: true, waiting: false })).toBe(avatarURL("star", "open"));
    expect(botFace({ avatar: "star", heads: ["claude"] }, "original", { asleep: true, working: false, waiting: false })).toBe(avatarURL("star", "closed"));
  });

  it("draws the Cute look from its head's character in the mood of the moment, its shape as a hat", () => {
    const pictures = { gpt: { working: "R1BU" }, claude: { idle: "Q0xB" } };
    const svg = decode(botFace({ avatar: "heart", heads: ["codex", "claude"] }, "cute", { asleep: false, working: true, waiting: false }, pictures));
    expect(svg).toContain("data:image/png;base64,R1BU");
    expect(svg).toContain("<svg x=\"22.5\"");
    // No picture for that mood: the original look.
    expect(botFace({ avatar: "heart", heads: ["claude"] }, "cute", { asleep: true, working: false, waiting: false }, pictures)).toBe(avatarURL("heart", "closed"));
  });
});
