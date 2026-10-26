/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inlineTokens } from "../kit/build.mjs";

// One set of design tokens (Web/src/tokens.css) for the app shell (desktop/src/renderer/styles.css),
// the chat page (chat.css) and the component kit. Moving them there must change no colour: each
// file still ends up with exactly the values it had before.
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
    for (const name of Object.keys(vars)) if (!(name in shellBefore)) expect(used(own).has(name), name).toBe(false);
    for (const name of used(own)) if (name.startsWith("--") && !/^--(board|message|task|chat)-/.test(name)) expect(vars[name] ?? own.includes(`${name}:`), name).toBeTruthy();
  });
});
