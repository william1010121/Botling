// The light look (Settings → Appearance → App) switches the design tokens (Web/src/tokens.css); a colour
// written straight into a stylesheet does not switch, and a dark one shows up as a black bar on the light
// page (the Catch-up card's loading bars and stacked edges did). This keeps the app's own stylesheets on
// the tokens: a dark colour outside a `:root` token block, or a black shadow or backdrop that does not
// scale with --shade (softer on light pages), fails here unless it is listed below with its reason.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const desktop = join(__dirname, "../..");
const repo = join(desktop, "..");
const sheets = [
  "Web/src/chat.css",
  "Web/kit/src/kit.css",
  "desktop/src/renderer/styles.css",
  "desktop/src/renderer/ModelPicker.css",
  "desktop/src/renderer/chat-frame/frame.css",
  "desktop/mobile/web.css",
  "desktop/builtin-plugins/botling.board/src/board.css",
  "desktop/builtin-plugins/botling.catchup/catchup.css",
  "desktop/builtin-plugins/botling.chat-extras/src/chat-extras.css",
  "desktop/builtin-plugins/botling.component-studio/studio.css",
  "desktop/builtin-plugins/botling.git/src/git.css",
  "desktop/builtin-plugins/botling.routines/src/routines.css",
  "desktop/builtin-plugins/botling.terminal/src/terminal.css",
  "desktop/builtin-plugins/botling.usage/src/usage.css",
  "desktop/builtin-plugins/botling.whiteboard/src/board.css",
];

/** `file: rule text` that may keep a dark colour, and why. */
const allowed: Record<string, string> = {
  // A video's letterbox is black in either look.
  "Web/src/chat.css: video.media": "letterbox",
  // The remove button on an attachment is a dark disc over a picture in either look (its × turns white in the light one).
  "Web/src/chat.css: .pending .remove": "dark disc over a picture",
};

const hex = /#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi;
function luminance(code: string): number {
  let h = code.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Top-level rules (selector, body) with comments taken out; @media and similar blocks are opened. */
function rules(css: string): Array<{ selector: string; body: string }> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ selector: string; body: string }> = [];
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selector: match[1].replace(/^[\s\S]*?@[^{]*\{/, "").trim(), body: match[2] });
  return out;
}

/** What in a stylesheet stays dark in the light look: a rule with a `[data-theme="light"]` rule of its own is the dark look's. */
export function darkColours(css: string): Array<{ selector: string; value: string }> {
  const found: Array<{ selector: string; value: string }> = [];
  const all = rules(css);
  const lightOnes = new Set(all.flatMap(({ selector }) => selector.split(",").map((one) => one.trim()))
    .filter((one) => one.startsWith(':root[data-theme="light"] ')).map((one) => one.slice(':root[data-theme="light"] '.length).trim()));
  for (const { selector, body } of all) {
    if (selector.split(",").every((one) => lightOnes.has(one.trim()))) continue;
    // Token blocks hold both looks' values; rules for the dark look only (or the light look) are fine.
    if (/^:root\b/.test(selector) && /^(:root(\[data-theme="(light|dark)"\])?\s*,?\s*)+$/.test(selector)) continue;
    if (/\[data-theme="light"\]/.test(selector)) continue;
    for (const declaration of body.split(";")) {
      const [property, ...rest] = declaration.split(":");
      const value = rest.join(":").trim();
      if (!value || property.trim().startsWith("--")) continue;
      for (const [code] of value.matchAll(hex)) {
        const alpha = code.length === 5 ? parseInt(code[4] + code[4], 16) / 255 : code.length === 9 ? parseInt(code.slice(7), 16) / 255 : 1;
        if (alpha > 0.07 && luminance(code) < 0.05) found.push({ selector, value: `${property.trim()}: ${value}` });
      }
      for (const [rgba, r, g, b, a] of value.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)/g)) {
        const code = "#" + [r, g, b].map((v) => Number(v).toString(16).padStart(2, "0")).join("");
        if (Number(a) > 0.07 && luminance(code) < 0.05) found.push({ selector, value: `${property.trim()}: ${value}` });
        void rgba;
      }
    }
  }
  return found;
}

describe("the light look: no dark colours written into the app's stylesheets", () => {
  it("finds a dark colour and a black shadow, and passes tokens and --shade", () => {
    expect(darkColours(".a { background: #26262C; } .b { box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5); }").map((f) => f.selector)).toEqual([".a", ".b"]);
    expect(darkColours(":root { --x: #141418; } :root[data-theme=\"light\"] { --x: #E8E8ED; } .a { background: var(--x); box-shadow: 0 8px 28px rgb(0 0 0 / calc(0.5 * var(--shade))); color: #fff; }")).toEqual([]);
    expect(darkColours(":root[data-theme=\"light\"] .a { color: #1C1C1F; } .b { color: #1A1206; }").map((f) => f.selector)).toEqual([".b"]);
    // A dark rule with its own light rule is the dark look's.
    expect(darkColours(".b { color: #1A1206; } :root[data-theme=\"light\"] .b { color: #fff; }")).toEqual([]);
  });

  for (const path of sheets) {
    it(path, () => {
      const css = readFileSync(join(repo, path), "utf8");
      const found = darkColours(css).filter(({ selector }) => !selector.split(",").some((one) => `${path}: ${one.trim()}` in allowed));
      expect(found, `${relative(repo, join(repo, path))}: use a token from Web/src/tokens.css (or the file's own :root variables with a light value), or --shade for black shadows`).toEqual([]);
    });
  }
});
