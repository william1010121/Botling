// The bots' faces: coloured shapes with big eyes, as the Swift app draws them (Avatar.swift),
// here as SVG data URLs so both the React chrome and the reused chat page can show them.

const COLORS: Record<string, string> = {
  circle: "#FF4B42", star: "#FFC915", square: "#2F86F6", triangle: "#2E9E3A", diamond: "#9B5CF0",
  clover: "#FF7A0A", heart: "#FF7EA0", hexagon: "#10C2C2", drop: "#FFBE0B", pentagon: "#58B4FA",
  cloud: "#B5E43A", octagon: "#FF9A72", moon: "#1550CC", pill: "#FF72A0", ghost: "#9B4FEB", burst: "#FF5A45",
};
export const SHAPES = Object.keys(COLORS);

export type Eyes = "open" | "happy" | "closed";

const f = (n: number) => Math.round(n * 1000) / 10; // 0..1 → 0..100 with one decimal
const polygon = (points: [number, number][]) => `<path d="M${points.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z"/>`;
const regular = (sides: number, rotation: number) =>
  polygon(Array.from({ length: sides }, (_, i) => {
    const angle = rotation + (i * 2 * Math.PI) / sides;
    return [0.5 + 0.48 * Math.cos(angle), 0.5 + 0.48 * Math.sin(angle)] as [number, number];
  }));
const circles = (list: [number, number, number][]) => list.map(([x, y, r]) => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}"/>`).join("");

function body(shape: string): string {
  switch (shape) {
    case "circle": return `<circle cx="50" cy="50" r="46"/>`;
    case "square": return `<rect x="6" y="10" width="88" height="80" rx="14"/>`;
    case "pill": return `<rect x="0" y="20" width="100" height="60" rx="30"/>`;
    case "triangle": return polygon([[0.5, 0.06], [0.96, 0.9], [0.04, 0.9]]);
    case "diamond": return polygon([[0.5, 0.02], [0.98, 0.5], [0.5, 0.98], [0.02, 0.5]]);
    case "star": return polygon(Array.from({ length: 10 }, (_, i) => {
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const radius = i % 2 === 0 ? 0.5 : 0.24;
      return [0.5 + radius * Math.cos(angle), 0.54 + radius * Math.sin(angle)] as [number, number];
    }));
    case "hexagon": return regular(6, 0);
    case "pentagon": return regular(5, -Math.PI / 2);
    case "octagon": return regular(8, Math.PI / 8);
    case "burst": return polygon(Array.from({ length: 24 }, (_, i) => {
      const angle = (i * Math.PI) / 12;
      const radius = i % 2 === 0 ? 0.5 : 0.38;
      return [0.5 + radius * Math.cos(angle), 0.5 + radius * Math.sin(angle)] as [number, number];
    }));
    case "clover": return circles([[0.5, 0.27, 0.23], [0.5, 0.73, 0.23], [0.27, 0.5, 0.23], [0.73, 0.5, 0.23], [0.5, 0.5, 0.25]]);
    case "cloud": return circles([[0.3, 0.58, 0.22], [0.5, 0.42, 0.26], [0.72, 0.58, 0.22], [0.5, 0.66, 0.2]]);
    case "heart": return `<path d="M50 92C22 72 4 58 4 36C4 8 40 4 50 22C60 4 96 8 96 36C96 58 78 72 50 92Z"/>`;
    case "drop": return `<path d="M50 4C64 22 90 40 90 62A40 40 0 0 1 10 62C10 40 36 22 50 4Z"/>`;
    case "ghost": return `<path d="M8 92V46A42 42 0 0 1 92 46V92Q78 98 64 86Q50 74 36 86Q22 98 8 92Z"/>`;
    case "moon": return `<circle cx="48" cy="52" r="44"/>`;
    default: return `<circle cx="50" cy="50" r="46"/>`;
  }
}

function eyesSVG(shape: string, eyes: Eyes): string {
  const shift = shape === "moon" ? -0.12 : 0;
  const eyeY = shape === "moon" ? 0.6 : shape === "triangle" ? 0.66 : shape === "drop" ? 0.6 : shape === "ghost" ? 0.45 : 0.48;
  const radius = shape === "moon" ? 0.1 : 0.125;
  return [0.36 + shift, 0.64 + shift].map((x) => {
    const cx = f(x), cy = f(eyeY), r = f(radius);
    if (eyes === "open") {
      const pupil = f(radius * 0.58);
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff"/><circle cx="${f(x + radius * 0.3)}" cy="${f(eyeY + radius * 0.05)}" r="${pupil}" fill="#000"/>`;
    }
    const arcR = f(radius * 0.8);
    const y = eyes === "happy" ? f(eyeY + radius * 0.4) : f(eyeY - radius * 0.3);
    // happy: an arc over the eye (a smile upside down, ^); closed: an arc under it.
    const from = eyes === "happy" ? `${cx - arcR * 0.94} ${y - arcR * 0.34}` : `${cx + arcR * 0.94} ${y + arcR * 0.34}`;
    const to = eyes === "happy" ? `${cx + arcR * 0.94} ${y - arcR * 0.34}` : `${cx - arcR * 0.94} ${y + arcR * 0.34}`;
    return `<path d="M${from}A${arcR} ${arcR} 0 0 1 ${to}" fill="none" stroke="#000" stroke-opacity="${eyes === "closed" ? 0.75 : 1}" stroke-width="4.5" stroke-linecap="round"/>`;
  }).join("");
}

const cache = new Map<string, string>();

/** The shape's own SVG (its body and eyes in a -4…104 box), in its own colour unless `color` is given. */
function shapeSVG(shape: string, eyes: Eyes, mask = "bite", color?: string): string {
  const known = COLORS[shape] ? shape : "circle";
  const fill = color ?? COLORS[known]!;
  // A same-coloured stroke rounds the polygons' corners, as in the Swift app.
  // The moon is a circle with a bite out of it (a mask, so the stroke is bitten too).
  const moon = known === "moon";
  const defs = moon ? `<defs><mask id="${mask}"><rect x="-4" y="-4" width="108" height="108" fill="#fff"/><circle cx="76" cy="32" r="30" fill="#000"/></mask></defs>` : "";
  return `${defs}<g fill="${fill}" stroke="${fill}" stroke-width="${moon ? 0 : 8}" stroke-linejoin="round"${moon ? ` mask="url(#${mask})"` : ""}>${body(known)}</g>${eyesSVG(known, eyes)}`;
}

/** An avatar as an SVG data URL. Unknown shapes draw as the main bot's circle; `color` replaces the shape's own. */
export function avatarURL(shape: string, eyes: Eyes = "open", color?: string): string {
  const key = `${shape}/${eyes}/${color ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 108 108">${shapeSVG(shape, eyes, "bite", color)}</svg>`;
  const url = `data:image/svg+xml;base64,${btoa(svg)}`;
  cache.set(key, url);
  return url;
}

// ---------------------------------------------------------------------------------------------
// Colour clashes: the shapes' colours are fixed, so two bots can look alike (the main bot's red
// circle and a red burst, two yellow stars and drops, a second bot on the same shape). Bots are
// taken in a stable order (the main bot, Maintainer, the pinned bots, the other bots, sub bots last,
// each group by id) and each keeps its shape's colour unless a bot before it already has one too
// close; then it gets the colour furthest from all taken so far. Once settled, a bot's colour is held
// (settings.json `botColors`, see heldBotColors): later bots, pins and removals never move it. The spare colours are the shapes' own, a few picked
// ones, then a wheel of hues at three lightnesses, so even ~60 bots each find a free colour (16
// shape colours alone ran out at a user's 46 bots, and every later clash then fell to the first
// spare, the main bot's red).

/** OKLab (L, a, b) of a #RRGGBB colour. */
export function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** #RRGGBB of an OKLCH colour, its chroma lowered until it fits in sRGB. */
function oklch(lightness: number, chroma: number, hueDeg: number): string {
  const h = (hueDeg * Math.PI) / 180;
  for (let c = chroma; c >= 0; c -= 0.005) {
    const [A, B] = [c * Math.cos(h), c * Math.sin(h)];
    const l = (lightness + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (lightness - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (lightness - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    if (rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) {
      return `#${rgb.map((v) => {
        const x = Math.min(1, Math.max(0, v));
        return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)).toString(16).padStart(2, "0");
      }).join("").toUpperCase()}`;
    }
  }
  return "#808080";
}

/** How far apart two colours look (OKLab distance; about 0.02 is "the same red"). */
export function colorDistance(a: string, b: string): number {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** Closer than this, two bots' colours clash. The shapes' own colours are all further apart, but for four near pairs. */
export const CLASH_DISTANCE = 0.06;
/** Colours a clashing bot may get: the shapes' own, a few picked ones, then a hue wheel at three lightnesses. */
export const SPARE_COLORS = [...new Set([
  ...Object.values(COLORS),
  "#E040C8", "#8A5A2B", "#6E7B8B", "#00A37A", "#3B3FD9", "#C2185B", "#7A9A00", "#00ACC1",
  ...[0.5, 0.68, 0.84].flatMap((lightness, ring) => Array.from({ length: 18 }, (_, i) => oklch(lightness, 0.16, i * 20 + ring * 10))),
])];

const MAINTAINER_ID = "DEC0DE00-0000-4000-8000-00000000DEC0";
type ColorBot = { id: string; avatar: string; role?: string; parent?: string | null };

/** Each bot's colour by id, clashes moved to the least clashing colour (see above). `pinned`: the
 * pinned bots' ids, served right after the main bot and Maintainer, as the column shows them together.
 * `held`: colours already settled (still on the same shape), kept as they are and taken first. */
export function resolveBotColors(bots: readonly ColorBot[], pinned: readonly string[] = [], held: HeldColors = {}): Map<string, string> {
  const rank = (bot: ColorBot) => (bot.role === "main" ? 0 : bot.id === MAINTAINER_ID ? 1 : pinned.includes(bot.id) ? 2 : bot.parent ? 4 : 3);
  const ordered = [...bots].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = new Map<string, string>();
  const taken: string[] = [];
  for (const bot of ordered) {
    const kept = held[bot.id];
    if (kept && kept.avatar === bot.avatar && !out.has(bot.id)) { out.set(bot.id, kept.color); taken.push(kept.color); }
  }
  const nearest = (color: string) => taken.reduce((min, other) => Math.min(min, colorDistance(color, other)), Infinity);
  for (const bot of ordered) {
    if (out.has(bot.id)) continue;
    const own = COLORS[bot.avatar] ?? COLORS.circle!;
    let color = own;
    if (nearest(own) < CLASH_DISTANCE) {
      let best = -1;
      for (const candidate of SPARE_COLORS) {
        const far = nearest(candidate);
        if (far > best + 1e-9) { best = far; color = candidate; }
      }
    }
    out.set(bot.id, color);
    taken.push(color);
  }
  return out;
}

/** Settled colours by bot id, with the shape each was settled on (settings.json `botColors`). */
export type HeldColors = Record<string, { avatar: string; color: string }>;

/**
 * The colours to keep from now on: every held one stays (whatever is added, removed or pinned), a new
 * bot or one on a new shape gets the least clashing colour against all held, a removed bot's is freed.
 * Nothing held yet (the first run): today's colours, as resolveBotColors gives them, become the held ones.
 */
export function heldBotColors(bots: readonly ColorBot[], pinned: readonly string[] = [], held: HeldColors | undefined): HeldColors {
  const colors = resolveBotColors(bots, pinned, held ?? {});
  const out: HeldColors = {};
  for (const bot of bots) {
    const color = colors.get(bot.id);
    if (color) out[bot.id] = { avatar: bot.avatar, color };
  }
  return out;
}

let botColors = new Map<string, string>();
let botColorsKey = "";
let botColorsHeld: HeldColors = {};

/** The app's bots, so every face drawn after this uses their colours (App calls it on each bot list).
 * `held`: the settled colours (settings `botColors`). Returns the colours to hold from now on, for App to keep. */
export function setBotColors(bots: readonly ColorBot[], pinned: readonly string[] = [], held?: HeldColors): HeldColors {
  const key = bots.map((bot) => `${bot.id}:${bot.avatar}:${bot.role ?? ""}:${bot.parent ?? ""}`).sort().join(",") + `|${pinned.join(",")}|${JSON.stringify(held ?? null)}`;
  if (key === botColorsKey) return botColorsHeld;
  botColorsKey = key;
  botColorsHeld = heldBotColors(bots, pinned, held);
  botColors = new Map(Object.entries(botColorsHeld).map(([id, entry]) => [id, entry.color]));
  return botColorsHeld;
}

/** Whether two held maps are the same (so App writes settings only on a change). */
export function sameHeldColors(a: HeldColors | undefined, b: HeldColors): boolean {
  const keys = Object.keys(b);
  return !!a && Object.keys(a).length === keys.length && keys.every((id) => a[id]?.avatar === b[id]!.avatar && a[id]?.color === b[id]!.color);
}

/** A bot's colour: its resolved one when the app knows it, else its shape's own. */
export function botColor(bot: { id?: string; avatar: string }): string {
  return (bot.id ? botColors.get(bot.id) : undefined) ?? COLORS[bot.avatar] ?? COLORS.circle!;
}

// ---------------------------------------------------------------------------------------------
// Bot look "Cute": the bot's own shape face with the head's character (Claude, Codex/gpt, or
// Antigravity/gemini) in the mood of the moment as a badge (1.x's Chibi.swift wore the face as a hat,
// too small to tell bots apart). The pictures are 1.x's CharacterArt/avatars-static, bundled in at build time.

declare const __CHARACTERS__: Record<string, Record<string, string>>;
export type Look = "original" | "cute";
export type Mood = "normal" | "work" | "think" | "sleep";
const EXPRESSION: Record<Mood, string> = { normal: "idle", work: "working", think: "thinking", sleep: "sleepy" };

/** `Chibi.mood(asleep:working:waiting:)`. */
export function mood(asleep: boolean, working: boolean, waiting: boolean): Mood {
  if (asleep) return "sleep";
  if (waiting) return "think";
  if (working) return "work";
  return "normal";
}

/** The pictures by character and expression (base64 PNG): bundled into the page; the core reads its own (core/faces.ts). */
export type Characters = Record<string, Record<string, string>>;

/** The picture of a head's character in a mood (base64 PNG), or null. */
function art(engine: string, moodNow: Mood, characters: Characters): string | null {
  // Antigravity is the engine ID; Gemini is the supplied character asset name.
  const character = engine === "codex" ? "gpt" : engine === "agy" || engine === "gemini" ? "gemini" : "claude";
  return characters[character]?.[EXPRESSION[moodNow]] ?? null;
}

/**
 * A head's face (`shape` null: its character alone, as the seen marks use it), as an SVG data URL.
 * With a shape, the bot's own shape face is the avatar and the character a round badge at its
 * bottom right (the "shape first" design): the face is what tells bots apart, the badge which
 * head speaks. Drawn below 26 px (the folded column, owner marks) the badge would be a smudge, so
 * the picture's own media query leaves only the face, filling the box.
 */
export function characterURL(engine: string, moodNow: Mood = "normal", shape: string | null = null, characters: Characters = typeof __CHARACTERS__ === "object" ? __CHARACTERS__ : {}, color?: string): string {
  const key = `chibi/${engine}/${moodNow}/${shape ?? ""}/${color ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const picture = art(engine, moodNow, characters);
  const eyes: Eyes = moodNow === "sleep" ? "closed" : "open";
  if (!picture) return avatarURL(shape ?? "circle", eyes, color);
  let svg: string;
  if (!shape) {
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><image x="0" y="0" width="64" height="64" preserveAspectRatio="xMidYMax meet" href="data:image/png;base64,${picture}"/></svg>`;
  } else {
    // In a 64 box: the face takes 0…57 (a 32 px avatar's 28.5 px), the badge 56% of the face across,
    // hanging past its corner as the design's -4 px does, cut out of the face by a 2.5 unit gap so it
    // reads on any background, light or dark.
    const r = 16, cx = 64 - r, cy = 64 - r, d = 2 * r;
    const zoom = engine === "agy" || engine === "gemini" ? { w: 1.24, x: 0.12, y: 0.12 } : { w: 1.32, x: 0.16, y: 0.04 };
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">`
      + `<style>.big{display:none}@media (min-width:26px){.big{display:inline}.small{display:none}}</style>`
      + `<defs><mask id="gap"><rect width="64" height="64" fill="#fff"/><circle cx="${cx}" cy="${cy}" r="${r + 2.5}" fill="#000"/></mask><clipPath id="badge"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>`
      + `<svg class="small" x="0" y="0" width="64" height="64" viewBox="-4 -4 108 108">${shapeSVG(shape, eyes, "bite-s", color)}</svg>`
      + `<g class="big"><g mask="url(#gap)"><svg x="0" y="0" width="57" height="57" viewBox="-4 -4 108 108">${shapeSVG(shape, eyes, "bite-b", color)}</svg></g>`
      + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#F3EEE8"/>`
      + `<g clip-path="url(#badge)"><image x="${cx - r - zoom.x * d}" y="${cy - r - zoom.y * d}" width="${zoom.w * d}" height="${zoom.w * d}" preserveAspectRatio="xMidYMin meet" href="data:image/png;base64,${picture}"/></g></g></svg>`;
  }
  const url = `data:image/svg+xml;base64,${btoa(svg)}`;
  cache.set(key, url);
  return url;
}

/** A bot's face in the look the settings name, in its resolved colour (see setBotColors). */
export function faceURL(bot: { id?: string; avatar: string; heads?: string[] }, look: Look, state: { asleep?: boolean; working?: boolean; waiting?: boolean; engine?: string } = {}, characters?: Characters): string {
  const color = botColor(bot);
  const own = color === (COLORS[bot.avatar] ?? COLORS.circle) ? undefined : color;
  if (look !== "cute") return avatarURL(bot.avatar, state.asleep ? "closed" : "open", own);
  return characterURL(state.engine ?? bot.heads?.[0] ?? "claude", mood(!!state.asleep, !!state.working, !!state.waiting), bot.avatar, characters, own);
}
