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
// Shared colours the shell adopted later (first by the whiteboard); other shell rules read them now.
const adoptedTokens = {
  "--notice": { dark: "#16161A", light: "#F0F0F3" }, "--border": { dark: "#2E2E35", light: "#DADADF" },
  "--raised": { dark: "#2C2C33", light: "#FFFFFF" }, "--link": { dark: "#8DB5FF", light: "#2F6FE0" },
  "--orange-line": { dark: "#6B4A1F", light: "#E8C79A" }, "--orange-text": { dark: "#F7C27F", light: "#9A5B00" },
};
// The light look (Botling 2's Settings → Appearance → App) moved the shell's and chat's remaining
// hard-coded colours onto tokens; each dark value is the colour that was written there before.
const lightLookTokens = {
  "--selected": { dark: "#26262C", light: "#E2E2E8" }, "--user-bubble": { dark: "#2B2B31", light: "#E9E9EE" },
  "--claude": { dark: "#D97757", light: "#C2603F" }, "--codex": { dark: "#6E9BFF", light: "#3D6FE0" },
  "--popover": { dark: "#1F1F24", light: "#FFFFFF" }, "--strong-line": { dark: "#3A3A42", light: "#CFCFD6" },
  "--active": { dark: "#2B3B5C", light: "#DCE7FB" }, "--info-bg": { dark: "#1A2233", light: "#E6EEFC" },
  "--info-line": { dark: "#2B3B5C", light: "#B9CEF5" }, "--accent-bg": { dark: "#1E2A44", light: "#EAF1FF" },
  "--accent-bg-hover": { dark: "#26375A", light: "#DCE7FB" }, "--accent-line": { dark: "#2F4F8F", light: "#B9CEF5" },
  "--card": { dark: "#232328", light: "#FFFFFF" }, "--card-line": { dark: "#303037", light: "#DADADF" },
  "--waiting-bg": { dark: "#2A2116", light: "#FFF4E2" }, "--done-bg": { dark: "#15291F", light: "#E3F4EA" },
  "--stale-bg": { dark: "#2E1B1A", light: "#FCE8E6" }, "--verify": { dark: "#8FD9B6", light: "#1E8A55" },
  "--verify-bg": { dark: "#16261E", light: "#E3F4EA" }, "--selection": { dark: "#33415E", light: "#CFDDF8" },
  "--slash-bg": { dark: "#1C1C20", light: "#FFFFFF" }, "--slash-line": { dark: "#29292F", light: "#E3E3E8" },
  "--hover-strong": { dark: "#33333B", light: "#E2E2E8" }, "--soft-text": { dark: "#C8C8CE", light: "#3F3F46" },
  "--panel-ground": { dark: "#111318", light: "#FFFFFF" }, "--panel-text": { dark: "#E5E7EB", light: "#1C1C1F" },
  "--panel-line": { dark: "#454850", light: "#DADADF" },
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
    for (const name of Object.keys(vars)) if (!(name in chatBefore) && !(name in lightLookTokens)) expect(used(own).has(name), name).toBe(false);
    for (const [name, { dark, light: lightValue }] of Object.entries(lightLookTokens)) { expect(vars[name], name).toBe(dark); expect(light[name], name).toBe(lightValue); }
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
    for (const [name, { dark, light: lightValue }] of Object.entries(adoptedTokens)) {
      expect(vars[name], name).toBe(dark);
      expect(light[name], name).toBe(lightValue);
    }
    // The shell reads only the tokens it always read (the whiteboard's own are the plugin's, builtin-plugins/botling.whiteboard); do not silently admit new token consumers.
    for (const name of Object.keys(vars)) if (!(name in shellBefore) && !(name in adoptedTokens) && !(name in lightLookTokens)) expect(used(own).has(name), name).toBe(false);
    for (const name of used(own)) if (name.startsWith("--") && !/^--(board|message|task|chat)-/.test(name)) expect(vars[name] ?? own.includes(`${name}:`), name).toBeTruthy();
  });
});
