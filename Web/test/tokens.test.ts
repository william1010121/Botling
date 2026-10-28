/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inlineTokens } from "../kit/build.mjs";

// One set of design tokens (Web/src/tokens.css) for the app shell (desktop/src/renderer/styles.css),
// the chat page (chat.css) and the component kit. Moving them there must change no colour: each
// file still ends up with exactly the values it had before. Later semantic token adoption
// is covered explicitly below, without treating those tokens as historically unused.
const web = join(__dirname, "..");
const read = (path: string) => readFileSync(join(web, path), "utf8");

/** The custom properties a stylesheet sets in its top-level `:root { … }` blocks (not `:root[…]`, not in @media). */
function rootVars(css: string, selector = ":root"): Record<string, string> {
  const vars: Record<string, string> = {};
  const top = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@(media|container|supports)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const blocks = top.matchAll(/(?<=^|\})()\s*([^{}]+?)\s*\{([^{}]*)\}/g);
  for (const [, , sel, body] of blocks) {
    if (sel.trim() !== selector) continue;
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) vars[name] = value.trim();
  }
  return vars;
}
const used = (css: string) => new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));

// What each file set in :root before tokens.css existed (8e4a85d).
const shellBefore = {
  "--ground": "#0E0E10", "--side": "#141417", "--bubble": "#1B1B1F", "--selected": "#26262C", "--hover": "#1F1F24",
  "--line": "#232327", "--text": "#EDEDF0", "--muted": "#A0A0A8", "--faint": "#8E8E96", "--chip": "#2A2A31",
  "--blue": "#4C8DFF", "--green": "#4CC38A", "--orange": "#F2A64A", "--error": "#FF8A80",
};
// Whiteboard adopted these existing shared colours in f52cbea; they are no longer
// unused shell tokens. Keep both theme values and their semantic consumers explicit.
const whiteboardTokens = {
  "--notice": { dark: "#16161A", light: "#F0F0F3", selector: ".wb-main", declaration: "background: var(--notice)" },
  "--border": { dark: "#2E2E35", light: "#DADADF", selector: ".wb-main", declaration: "border: 1px solid var(--border)" },
  "--raised": { dark: "#2C2C33", light: "#FFFFFF", selector: ".wb-toc-chip.on, .wb-toc-chip:hover", declaration: "background: var(--raised)" },
  "--link": { dark: "#8DB5FF", light: "#2F6FE0", selector: ".wb-stat-n.active", declaration: "color: var(--link)" },
  "--orange-line": { dark: "#6B4A1F", light: "#E8C79A", selector: ".wb-ask", declaration: "border: 1px solid var(--orange-line)" },
  "--orange-text": { dark: "#F7C27F", light: "#9A5B00", selector: ".wb-part-title.ask", declaration: "color: var(--orange-text)" },
};
// Whiteboard-local additions from the same change, not imported shared tokens.
const whiteboardLocalDark = {
  "--section-bg": "rgba(22, 22, 26, 0.75)", "--hover-line": "#3A3A42", "--dot": "#1C1C21",
  "--amber-bg": "#2A2116", "--amber-soft": "#211B14", "--amber-glow": "rgba(242, 166, 74, 0.13)",
  "--waiting-bar": "#F7C27F", "--done-bar": "#2F6B4F", "--link-bg": "#1A2233", "--asleep": "#4A4A52",
  "--tip-bg": "#2C2C33", "--tip-text": "#EDEDF0", "--tip-muted": "#A0A0A8",
  "--shadow": "rgba(0, 0, 0, 0.45)", "--scrim": "rgba(14, 14, 16, 0.62)", "--pill-text": "#F7C27F",
};
const whiteboardLocalLight = {
  "--section-bg": "rgba(255, 255, 255, 0.6)", "--hover-line": "#C8C8D0", "--dot": "#DEDEE4",
  "--amber-bg": "#FFF5E6", "--amber-soft": "#FFFAF2", "--amber-glow": "rgba(178, 106, 0, 0.12)",
  "--waiting-bar": "#E0A04A", "--done-bar": "#7FC4A1", "--link-bg": "#EAF1FF", "--asleep": "#C4C4CC",
  "--tip-bg": "#1C1C1F", "--tip-text": "#EDEDF0", "--tip-muted": "#A0A0A8",
  "--shadow": "rgba(0, 0, 0, 0.12)", "--scrim": "rgba(245, 245, 247, 0.7)", "--pill-text": "#6B3E00",
};
const chatBefore = {
  "--chat-avatar-size": "48px", "--ground": "#0E0E10", "--bubble": "#1B1B1F", "--user-bubble": "#2B2B31", "--notice": "#16161A",
  "--line": "#232327", "--text": "#EDEDF0", "--muted": "#A0A0A8", "--faint": "#8E8E96", "--chip": "#2A2A31", "--blue": "#4C8DFF",
  "--link": "#8DB5FF", "--green": "#4CC38A", "--orange-line": "#6B4A1F", "--orange-text": "#F7C27F", "--error": "#FF8A80",
  "--code": "#111114", "--control-h": "32px", "--control-radius": "10px", "--border": "#2E2E35", "--raised": "#2C2C33",
  "--claude": "#D97757", "--codex": "#6E9BFF",
};
const chatLightBefore = { "--border": "#DADADF", "--raised": "#FFFFFF", "--claude": "#C2603F", "--codex": "#3D6FE0" };

describe("tokens.css", () => {
  const tokens = read("src/tokens.css");

  it("holds the colours, dark by default, with a light set under [data-theme=light]", () => {
    const dark = rootVars(tokens);
    const light = rootVars(tokens, ':root[data-theme="light"]');
    for (const name of ["--ground", "--bubble", "--line", "--text", "--muted", "--chip", "--blue", "--green", "--orange", "--error"]) {
      expect(dark[name], name).toMatch(/^#[0-9A-F]{6}$/);
      expect(light[name], name).toMatch(/^#[0-9A-F]{6}$/);
      expect(light[name], name).not.toBe(dark[name]);
    }
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
  });

  it("leaves the chat page's colours as they were", () => {
    const own = read("src/chat.css");
    expect(own).toMatch(/^@import "\.\/tokens\.css";/);
    const css = inlineTokens(own, join(web, "src/chat.css"));
    expect(css).not.toContain("@import");
    const vars = rootVars(css);
    for (const [name, value] of Object.entries(chatBefore)) expect(vars[name], name).toBe(value);
    const light = rootVars(css, ':root[data-theme="light"]');
    for (const [name, value] of Object.entries(chatLightBefore)) expect(light[name], name).toBe(value);
    // Tokens the chat did not have before are ones it never reads.
    for (const name of Object.keys(vars)) if (!(name in chatBefore)) expect(used(own).has(name), name).toBe(false);
    // Each colour is set once, in tokens.css.
    for (const name of Object.keys(rootVars(tokens))) expect(rootVars(own)[name], name).toBeUndefined();
  });

  it("leaves the app shell's colours as they were", () => {
    const path = join(web, "../desktop/src/renderer/styles.css");
    const own = readFileSync(path, "utf8");
    expect(own).toMatch(/^@import "[./]*Web\/src\/tokens\.css";/m);
    const css = inlineTokens(own, path);
    const vars = rootVars(css);
    for (const [name, value] of Object.entries(shellBefore)) expect(vars[name], name).toBe(value);
    const light = rootVars(css, ':root[data-theme="light"]');
    const rules = [...own.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const [name, { dark, light: lightValue, selector, declaration }] of Object.entries(whiteboardTokens)) {
      expect(vars[name], name).toBe(dark);
      expect(light[name], name).toBe(lightValue);
      expect(used(own).has(name), name).toBe(true);
      expect(rules.find(([, rule]) => rule.trim() === selector)?.[2], selector).toContain(`${declaration};`);
    }
    expect(rootVars(own)).toEqual(whiteboardLocalDark);
    expect(rootVars(own, ':root[data-theme="light"]')).toEqual(whiteboardLocalLight);
    for (const name of Object.keys(whiteboardLocalDark)) expect(used(own).has(name), name).toBe(true);
    // All other additions remain unused; do not silently admit new token consumers.
    for (const name of Object.keys(vars)) if (!(name in shellBefore) && !(name in whiteboardTokens) && !(name in whiteboardLocalDark)) expect(used(own).has(name), name).toBe(false);
    for (const name of used(own)) if (name.startsWith("--") && !/^--(board|message|task|chat)-/.test(name)) expect(vars[name] ?? own.includes(`${name}:`), name).toBeTruthy();
  });
});
