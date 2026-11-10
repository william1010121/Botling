// A bot's colour, once settled, stays: adding or removing a bot, pinning one or a restart never
// moves another bot's colour. Only a new bot (or one whose shape changed) gets a colour chosen now,
// the least clashing against all colours already held. The map lives in settings.json `botColors`.
import { describe, expect, it } from "vitest";
import { applySetting, settingsView } from "../../src/core/settings";
import { CLASH_DISTANCE, colorDistance, type HeldColors, heldBotColors, resolveBotColors } from "../../src/renderer/avatars";

const MAIN = { id: "M", role: "main", avatar: "circle" };
const base = [MAIN, { id: "b", avatar: "square" }, { id: "c", avatar: "square" }, { id: "d", avatar: "burst" }];
const colorsOf = (held: HeldColors) => new Map(Object.entries(held).map(([id, entry]) => [id, entry.color]));

describe("recomputed colours (before)", () => {
  it("move another bot's colour when a bot is added or pinned", () => {
    const before = resolveBotColors(base);
    const added = resolveBotColors([...base, { id: "a", avatar: "square" }]);
    expect(added.get("b")).not.toBe(before.get("b")); // a new "a" sorts before "b" and takes its colour
    const pinned = resolveBotColors(base, ["c"]);
    expect(pinned.get("b")).not.toBe(before.get("b"));
  });
});

describe("held colours", () => {
  it("seeds from today's colours on the first run", () => {
    expect(colorsOf(heldBotColors(base, [], undefined))).toEqual(resolveBotColors(base));
  });

  it("keeps every held colour when a bot is added, pinned or removed", () => {
    const held = heldBotColors(base, [], undefined);
    const added = heldBotColors([...base, { id: "a", avatar: "square" }], [], held);
    for (const bot of base) expect(added[bot.id]).toEqual(held[bot.id]);
    for (const bot of base) expect(added.a!.color === held[bot.id]!.color).toBe(false);
    expect(Math.min(...base.map((bot) => colorDistance(added.a!.color, held[bot.id]!.color)))).toBeGreaterThan(CLASH_DISTANCE);
    expect(heldBotColors(base, ["c", "d"], held)).toEqual(held);
    const removed = heldBotColors(base.filter((bot) => bot.id !== "c"), [], held);
    expect(removed.c).toBeUndefined();
    expect(removed.b).toEqual(held.b);
  });

  it("frees a removed bot's colour and gives a new bot a colour again when its shape changes", () => {
    const held = heldBotColors(base, [], undefined);
    const removed = heldBotColors(base.filter((bot) => bot.id !== "b"), [], held);
    const back = heldBotColors([...base.filter((bot) => bot.id !== "b"), { id: "e", avatar: "square" }], [], removed);
    expect(back.e!.color).toBe(held.b!.color); // the square's own blue is free again
    const reshaped = heldBotColors(base.map((bot) => (bot.id === "d" ? { ...bot, avatar: "heart" } : bot)), [], held);
    expect(reshaped.d).toEqual({ avatar: "heart", color: "#FF7EA0" });
    expect(reshaped.b).toEqual(held.b);
  });

  it("is kept in settings.json as botColors", () => {
    const held = heldBotColors(base, [], undefined);
    const raw = applySetting({}, { key: "botColors", value: held });
    expect(settingsView(raw).botColors).toEqual(held);
    expect(settingsView({ botColors: { x: { avatar: "star", color: "red" }, y: 3 } }).botColors).toEqual({});
  });
});
