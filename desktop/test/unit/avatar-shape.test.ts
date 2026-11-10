// The bots' avatars, "shape first" (design round 2, option C): the bot's own shape face is the
// avatar, the head's character a small round badge at its bottom right (gone below 26 px), and bots
// whose colours clash get the least clashing colour, the same on every start.
import { afterEach, describe, expect, it } from "vitest";
import type { BotView } from "../../src/contract";
import { avatarURL, botColor, CLASH_DISTANCE, characterURL, colorDistance, faceURL, resolveBotColors, setBotColors } from "../../src/renderer/avatars";
import { chatState } from "../../src/renderer/payload";

const decode = (url: string) => Buffer.from(url.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");
const pictures = { claude: { idle: "Q0xB", working: "V09SSw" }, gpt: { idle: "R1BU" }, gemini: { idle: "R0VN" } };
const MAIN = { id: "M", role: "main", avatar: "circle" };
const MAINTAINER = { id: "DEC0DE00-0000-4000-8000-00000000DEC0", role: "bot", avatar: "diamond" };

afterEach(() => setBotColors([]));

describe("colour clashes", () => {
  it("keeps every bot's own colour when nothing clashes", () => {
    const colors = resolveBotColors([MAIN, { id: "a", avatar: "square" }, { id: "b", avatar: "star" }]);
    expect([...colors.values()]).toEqual(["#FF4B42", "#2F86F6", "#FFC915"]);
  });

  it("moves the later of two near colours (the main bot's red circle and a red burst), never the main bot", () => {
    const colors = resolveBotColors([{ id: "0", avatar: "burst" }, MAIN]);
    expect(colors.get("M")).toBe("#FF4B42");
    expect(colors.get("0")).not.toBe("#FF5A45");
    expect(colorDistance(colors.get("0")!, "#FF4B42")).toBeGreaterThan(CLASH_DISTANCE);
  });

  it("gives a bot on the same shape as another a different colour, the one furthest from all taken", () => {
    const bots = [MAIN, MAINTAINER, { id: "a", avatar: "square" }, { id: "b", avatar: "square" }, { id: "c", avatar: "ghost" }, { id: "d", avatar: "drop" }, { id: "e", avatar: "star" }];
    const colors = resolveBotColors(bots);
    const all = [...colors.values()];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(colorDistance(all[i]!, all[j]!)).toBeGreaterThan(CLASH_DISTANCE);
    expect(colors.get(MAINTAINER.id)).toBe("#9B5CF0"); // Maintainer goes second and keeps its purple; the ghost moves.
    expect(colors.get("c")).not.toBe("#9B4FEB");
  });

  it("is the same whatever order the bots come in (stable across restarts and column re-sorts)", () => {
    const bots = [MAIN, MAINTAINER, ...["square", "burst", "heart", "pill", "star", "drop", "square", "ghost"].map((avatar, i) => ({ id: `id-${i}`, avatar }))];
    const once = resolveBotColors(bots);
    const shuffled = resolveBotColors([...bots].reverse());
    expect([...shuffled.entries()].sort()).toEqual([...once.entries()].sort());
  });

  it("still picks the least clashing colour when there are more bots than colours", () => {
    const bots = [MAIN, ...Array.from({ length: 30 }, (_, i) => ({ id: `b${String(i).padStart(2, "0")}`, avatar: "circle" }))];
    const colors = resolveBotColors(bots);
    expect(colors.size).toBe(31);
    expect(resolveBotColors(bots)).toEqual(colors);
  });

  it("draws each face in the resolved colour once the app has told it the bots", () => {
    const burst = { id: "x", avatar: "burst" };
    expect(botColor(burst)).toBe("#FF5A45");
    setBotColors([MAIN, burst]);
    const moved = botColor(burst);
    expect(moved).not.toBe("#FF5A45");
    expect(decode(faceURL(burst, "original"))).toContain(`fill="${moved}"`);
    expect(decode(faceURL(burst, "cute", {}, pictures))).toContain(`fill="${moved}"`);
    expect(faceURL(MAIN, "original")).toBe(avatarURL("circle"));
  });

  it("uses the resolved colours in the chat page's avatars too", () => {
    const view = (id: string, avatar: string, role: BotView["role"]): BotView => ({ id, name: id, role, avatar, folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] });
    const main = view("M", "circle", "main"), burst = view("x", "burst", "bot");
    setBotColors([main, burst]);
    const chat = { botId: "x", messages: [], running: null, live: [], runs: [], heads: null };
    const { state } = chatState(burst, chat as never, new Date(), null, { look: "original", bots: [main, burst] });
    expect(decode(state.avatar!)).toContain(`fill="${botColor(burst)}"`);
  });
});

describe("the shape-first face", () => {
  it("is the bot's shape face with the head's character in a round badge at its bottom right, no hat", () => {
    const svg = decode(characterURL("codex", "normal", "star", pictures));
    expect(svg).toContain('fill="#FFC915"');
    expect(svg).toContain('<clipPath id="badge"><circle cx="48" cy="48" r="16"/>');
    expect(svg).toContain('clip-path="url(#badge)"><image');
    expect(svg).toContain("data:image/png;base64,R1BU");
    // The badge is cut out of the face with a gap so it reads on light and dark backgrounds.
    expect(svg).toContain('<mask id="gap">');
    expect(svg).toContain('r="18.5" fill="#000"');
    expect(svg).not.toContain('x="22.5"');
  });

  it("drops the badge below 26 px (folded column, owner marks), the face then filling the box", () => {
    const svg = decode(characterURL("claude", "normal", "moon", pictures));
    expect(svg).toContain(".big{display:none}@media (min-width:26px){.big{display:inline}.small{display:none}}");
    expect(svg).toMatch(/<svg class="small" x="0" y="0" width="64" height="64"/);
    expect(svg).toMatch(/<g class="big">.*width="57" height="57"/);
    // Two moons in one picture: each bite mask has its own id.
    expect(svg).toContain('id="bite-s"');
    expect(svg).toContain('id="bite-b"');
  });

  it("tells the heads apart by the badge and the bots by the face; closes the face's eyes asleep", () => {
    expect(characterURL("claude", "normal", "star", pictures)).not.toBe(characterURL("agy", "normal", "star", pictures));
    expect(decode(characterURL("agy", "normal", "star", pictures))).toContain("R0VN");
    const asleep = decode(characterURL("claude", "sleep", "star", { claude: { sleepy: "U0xQ" } }));
    expect(asleep).toContain("stroke-opacity=\"0.75\"");
  });

  it("keeps the character alone for the seen marks (no shape)", () => {
    const svg = decode(characterURL("claude", "normal", null, pictures));
    expect(svg).not.toContain("badge");
    expect(svg).toContain("Q0xB");
  });
});
