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

  it("still gives a user's 46 bots distinct colours (16 shape colours ran out; every later clash fell to the main bot's red)", () => {
    // The user's real top-level bots (projects.json), plus 15 sub bots on the reds and the main bot and Maintainer.
    const real: [string, string, string][] = [["35755CC2-281D-4707-9251-7049C09C2841", "square", "EEG-remove-signaltual"], ["DCC66D54-07D2-441E-9A47-92317D74B169", "triangle", "ai-cgroup"], ["7757A552-476C-495C-BA93-93A2907A4340", "hexagon", "token-speed"], ["3CCCE0BE-F505-4C3A-AFD4-9C6902CE239C", "star", "view-latex-md"], ["6F097BCC-C202-476C-9C82-859432BC7DA5", "diamond", "chatgpt-extension"], ["9574ED38-C902-4701-97F3-BE5F7B5D3D6F", "clover", "disk-ananlyze"], ["92FCB255-BF5B-4543-B788-91EE69B174AB", "heart", "laas-0.6.1"], ["95D5E320-1068-4A8E-9AA6-9B9D7005363D", "drop", "laas-0.7.2"], ["DB21BA12-C95A-4590-9FCF-0CDCF4DC493A", "pentagon", "laas-copy"], ["98BDBF26-850C-4521-AEB4-CCF9073E8BD0", "cloud", "botling"], ["4D183B94-CE43-425C-9A34-688774F59D71", "octagon", "Deck"], ["38625952-22DE-4229-8F59-FA2995756556", "moon", "NotchDo"], ["D3836D93-B3B9-4317-9471-7A66EA467DC2", "pill", "YTP_Webpage_Diary"], ["6290B52A-F62B-4485-8511-6C888E53A1B8", "ghost", "socrate"], ["7E8758CD-D903-4F38-BEAA-FD4CE3183961", "burst", "cv-compress"], ["DE9A5A2E-86F8-4F8C-B734-E1B0CB0DB066", "square", "dafaji"], ["525203F0-FF85-4BAD-92D3-C77EA8B633F2", "triangle", "eeg"], ["51EE5BF3-96F0-4B3E-B276-5EF3433EE163", "hexagon", "icpc-codebook"], ["05CCFE79-A859-4A65-8B60-CB462588655D", "star", "math-innovations"], ["FB41101C-FF52-447A-BF2A-B0BFB3194207", "diamond", "neural-interfaces-2026"], ["998D3E81-C986-4C97-8BDE-B517824624D5", "clover", "Users"], ["2B98993D-9517-40B5-94B3-0CB9A0983B6A", "heart", "X"], ["D66BE5B7-2152-4BCA-A4EA-7B7FE509707F", "drop", "共用"], ["8498B140-7DE6-49E2-8734-825E85FEC99C", "pentagon", "disk"], ["5A96229D-A289-4F28-B4D5-B9BE4B7F6333", "cloud", "jenytsian_progress"], ["DF19EE79-F6D8-4BB2-93E6-5BD085633434", "octagon", "CSIT"], ["BC243C06-7AF9-488C-940B-03DC35C2DB2C", "moon", "CLIC-website"], ["7FD11DEE-A493-4107-9754-24D43A939EE5", "pill", "resilient-shannon"], ["6AC64E3A-C7D7-4382-B8A1-9A4756A8F77C", "ghost", "flux-k8s"]];
    const top = real.map(([id, avatar]) => ({ id, avatar }));
    const subs = Array.from({ length: 15 }, (_, i) => ({ id: `SUB${i}`, avatar: ["circle", "burst", "octagon", "cloud", "star"][i % 5]!, parent: real[i]![0] }));
    const bots = [MAIN, MAINTAINER, ...top, ...subs];
    const colors = resolveBotColors(bots);
    const red = (name: string) => colorDistance(colors.get(real.find(([, , n]) => n === name)![0])!, "#FF4B42");
    for (const name of ["botling", "cv-compress", "CSIT", "laas-copy", "ai-cgroup"]) expect(red(name)).toBeGreaterThan(CLASH_DISTANCE);
    expect(new Set(colors.values()).size).toBe(bots.length);
    const shown = [MAIN, MAINTAINER, ...top].map((bot) => colors.get(bot.id)!);
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(colorDistance(shown[i]!, shown[j]!)).toBeGreaterThan(CLASH_DISTANCE);
  });

  it("serves the pinned bots right after the main bot and Maintainer, sub bots last", () => {
    const bots = [MAIN, { id: "a", avatar: "circle" }, { id: "b", avatar: "circle", parent: "a" }, { id: "z", avatar: "circle" }];
    const plain = resolveBotColors(bots);
    const pinned = resolveBotColors(bots, ["z"]);
    expect(pinned.get("z")).toBe(plain.get("a"));
    expect(pinned.get("a")).toBe(plain.get("z"));
    expect(colorDistance(pinned.get("b")!, "#FF4B42")).toBeGreaterThan(CLASH_DISTANCE);
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
