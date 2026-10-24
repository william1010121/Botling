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

/** An avatar as an SVG data URL. Unknown shapes draw as the main bot's circle. */
export function avatarURL(shape: string, eyes: Eyes = "open"): string {
  const key = `${shape}/${eyes}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const known = COLORS[shape] ? shape : "circle";
  const color = COLORS[known]!;
  // A same-coloured stroke rounds the polygons' corners, as in the Swift app.
  // The moon is a circle with a bite out of it (a mask, so the stroke is bitten too).
  const moon = known === "moon";
  const defs = moon ? `<defs><mask id="bite"><rect x="-4" y="-4" width="108" height="108" fill="#fff"/><circle cx="76" cy="32" r="30" fill="#000"/></mask></defs>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 108 108">${defs}<g fill="${color}" stroke="${color}" stroke-width="${moon ? 0 : 8}" stroke-linejoin="round"${moon ? ' mask="url(#bite)"' : ""}>${body(known)}</g>${eyesSVG(known, eyes)}</svg>`;
  const url = `data:image/svg+xml;base64,${btoa(svg)}`;
  cache.set(key, url);
  return url;
}
