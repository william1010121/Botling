// A bot's face for plugins (`workspace.face`): the same SVG data URL the app draws (renderer/avatars.ts),
// in the look asked for and the bot's state now. The Cute pictures are read once from characters.json
// beside the core bundle (build.mjs writes it); without it a Cute face draws in the original look.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { faceURL, type Characters } from "../renderer/avatars";

let loaded: Characters | null | undefined;

function characters(): Characters | undefined {
  if (loaded === undefined) {
    try { loaded = JSON.parse(readFileSync(join(__dirname, "characters.json"), "utf8")) as Characters; } catch { loaded = null; }
  }
  return loaded ?? undefined;
}

export interface FaceState { asleep: boolean; working: boolean; waiting: boolean }

export function botFace(bot: { avatar: string; heads: string[] }, look: "original" | "cute", state: FaceState, pictures: Characters | undefined = look === "cute" ? characters() : undefined): string {
  return faceURL(bot, look, state, pictures);
}
