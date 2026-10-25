// `botling --component-shot <component folder>` (the Swift app's ComponentShot.swift): draws one
// component the way this build of the app draws it, in the real chat page, on every surface (in a chat
// reply, as Board tiles of several sizes, opened above the input box, floating in a corner), takes
// pictures, and reports what is wrong: script errors, failed `ccb` calls, missing resources, content
// wider than its frame, and frames that draw nothing. The drawing is Electron main's (src/main/shot.ts);
// what is measured, how it is judged and how it is reported is here, so it can be tested. Every string
// here is 1.x's, checked against the Swift code (test/fixtures/phase5-golden.json, `more.shots`).
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { aboutLine, spelledSize } from "./components/library";
import { COMMAND_TIMEOUT_MS, OUTPUT_LIMIT, execute, type CommandOutcome } from "./components/commands";

export const FLAG = "--component-shot";

export const SURFACES = ["chat", "board", "pinned", "floating"] as const;
export type Surface = (typeof SURFACES)[number];

/** The Board sizes shot when neither `--sizes` nor the about.md `Sizes:` line names others: the smallest, a wide strip, the default and the chat's widest. */
export const DEFAULT_SIZES = ["1x1", "2x1", "2x2", "4x2"];
/** Every size a card can take, row by row: 1×1, 2×1, … 4×4 (`PinnedComponent.Size.all`). */
export const ALL_SIZES = [1, 2, 3, 4].flatMap((rows) => [1, 2, 3, 4].map((columns) => `${columns}x${rows}`));
/** "1x1 to 4x4" (`PinnedComponent.Size.rangeText`). */
const RANGE_TEXT = "1x1 to 4x4";

export interface ShotOptions {
  component: string;
  out: string;
  data: string | null;
  /** The project folder its about.md `Command:` runs in; without it the plugin folder. */
  folder: string | null;
  surfaces: Surface[];
  /** Board sizes; null: `DEFAULT_SIZES` plus the about.md hints. */
  sizes: string[] | null;
  theme: string;
}

export function isRequested(argv: readonly string[]): boolean {
  return argv.includes(FLAG);
}

export const USAGE = `Usage: botling --component-shot <component folder> [--out <dir>] [--data <file.json>] [--folder <project dir>]
                     [--surfaces chat,board,pinned,floating] [--sizes 1x1,2x1,2x2,4x2 | all] [--theme dark]
Draws the component in this build's real chat page on each surface, saves a picture of each
and a contact sheet, and lists what is wrong. Exit 0: no problems, 1: problems, 2: bad usage.
Data: --data, else its Command run in --folder, else about.md's example (\`\`\`json block or Data: line), else null.
A Command: line in about.md is always run once as written (in --folder, else the plugin folder); a failure is a problem.`;

/** Why the command line was refused: `usage` adds the usage text below (`ShotError.description`). */
export class ShotError extends Error {
  constructor(readonly kind: "usage" | "unsupported", readonly text: string) {
    super(kind === "usage" ? `${text}\n\n${USAGE}` : text);
  }
}

/** Swift's `.whitespaces` (spaces and tabs, not newlines). */
const trimSpaces = (text: string) => text.replace(/^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu, "");
/** Swift's `split(separator:)`: empty parts left out. */
const parts = (text: string, separator: string) => text.split(separator).filter((part) => part.length > 0);

/** Reads the command line (`ComponentShot.parse`). `cwd` resolves relative paths; `now` names the default out folder. */
export function parse(argv: readonly string[], cwd = process.cwd(), now = Date.now()): { ok: true; options: ShotOptions } | { ok: false; error: ShotError } {
  const fail = (kind: "usage" | "unsupported", text: string) => ({ ok: false as const, error: new ShotError(kind, text) });
  const at = argv.indexOf(FLAG);
  if (at < 0 || at + 1 >= argv.length || argv[at + 1]!.startsWith("--")) return fail("usage", "Name the component folder (the one with template.html).");
  const path = (text: string) => (isAbsolute(text) ? resolve(text) : resolve(cwd, text));
  const component = path(argv[at + 1]!);
  const options: ShotOptions = {
    component,
    out: resolve(tmpdir(), `ccb-shot-${basename(component)}-${Math.floor(now / 1000)}`),
    data: null, folder: null, surfaces: [...SURFACES], sizes: null, theme: "dark",
  };
  let index = at + 2;
  while (index < argv.length) {
    const flag = argv[index]!;
    if (!["--out", "--data", "--folder", "--surfaces", "--sizes", "--theme"].includes(flag)) { index += 1; continue; }
    if (index + 1 >= argv.length) return fail("usage", `${flag} needs a value.`);
    const value = argv[index + 1]!;
    switch (flag) {
      case "--out": options.out = path(value); break;
      case "--data": options.data = path(value); break;
      case "--folder": options.folder = path(value); break;
      case "--surfaces": {
        const surfaces: Surface[] = [];
        for (const part of parts(value, ",")) {
          const name = trimSpaces(part).toLowerCase();
          if (!(SURFACES as readonly string[]).includes(name)) return fail("usage", `Unknown surface ${name}: chat, board, pinned or floating.`);
          if (!surfaces.includes(name as Surface)) surfaces.push(name as Surface);
        }
        if (!surfaces.length) return fail("usage", "--surfaces names none.");
        options.surfaces = surfaces;
        break;
      }
      case "--sizes": {
        if (value.toLowerCase() === "all") {
          options.sizes = [...ALL_SIZES];
          break;
        }
        const sizes: string[] = [];
        for (const part of parts(value, ",")) {
          const size = spelledSize(part);
          if (!size) return fail("usage", `Not a Board size: ${part} (${RANGE_TEXT}).`);
          if (!sizes.includes(size)) sizes.push(size);
        }
        if (!sizes.length) return fail("usage", "--sizes names none.");
        options.sizes = sizes;
        break;
      }
      default:
        options.theme = value.toLowerCase();
    }
    index += 2;
  }
  if (options.theme !== "dark") {
    return fail("unsupported", `The app only draws components in the dark theme (its window and every component frame are dark), so there is no ${options.theme} theme to shoot.`);
  }
  if (!existsSync(resolve(component, "template.html"))) return fail("usage", `No template.html in ${component}.`);
  return { ok: true, options };
}

/** The Board sizes to shoot: those asked for, else the defaults followed by any its about.md hints. */
export function shotSizes(asked: string[] | null, hinted: string[]): string[] {
  if (asked) return asked;
  const sizes = [...DEFAULT_SIZES];
  for (const size of hinted) if (!sizes.includes(size)) sizes.push(size);
  return sizes;
}

/** How many rows a size takes ("4x2" → 2). */
export const rowsOf = (size: string) => Number(size.split("x")[1] ?? 1);

// ---------------------------------------------------------------------------------------------
// Data

export function isJSON(text: string): boolean {
  if (!text) return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

function jsonBlock(about: string): string | null {
  let inside = false;
  let lines: string[] = [];
  for (const line of about.split("\n")) {
    const trimmed = trimSpaces(line);
    if (!inside) {
      if (trimmed.toLowerCase().startsWith("```json")) { inside = true; lines = []; }
      continue;
    }
    if (trimmed.startsWith("```")) {
      const json = lines.join("\n").trim();
      if (isJSON(json)) return json;
      inside = false;
      continue;
    }
    lines.push(line);
  }
  return null;
}

/** The example a bot is shown in an about.md: its first ```json block that holds valid JSON, else the first "Data: {…}" (or "Example: …") line whose rest is JSON. */
export function sampleData(about: string): string | null {
  const block = jsonBlock(about);
  if (block !== null) return block;
  for (const line of about.split("\n")) {
    let text = trimSpaces(line);
    if (text.startsWith("- ") || text.startsWith("* ")) text = text.slice(2);
    for (const label of ["data:", "example:", "example data:", "sample:"]) {
      if (!text.toLowerCase().startsWith(label)) continue;
      const rest = trimSpaces([...text].slice(label.length).join("").replace(/^[` ]+|[` ]+$/g, ""));
      if ((rest.startsWith("{") || rest.startsWith("[")) && isJSON(rest)) return rest;
    }
  }
  return null;
}

/** Where the data came from, for the report (`DataSource.description`). */
export type DataSource = { kind: "file"; path: string } | { kind: "command"; command: string } | { kind: "example" } | { kind: "none" };

export function sourceText(source: DataSource): string {
  switch (source.kind) {
    case "file": return `the file ${source.path}`;
    case "command": return `its Command (${source.command})`;
    case "example": return "about.md's example";
    case "none": return "null (no --data, no Command run, no example in about.md)";
  }
}

// ---------------------------------------------------------------------------------------------
// Its Command

/** How long the check gives a component's Command (the chat gives it `COMMAND_TIMEOUT_MS`), in seconds. */
export const COMMAND_CHECK_TIMEOUT = 30;

export interface Finding { level: "problem" | "warning"; place: string; text: string }

export interface CommandCheck {
  command: string;
  folder: string;
  outcome: CommandOutcome;
  /** A problem when it fails as the chat would show "The command failed"; a warning when it only took longer than the check waits. */
  findings: Finding[];
}

/** Where its Command runs when no project folder is given: the plugin folder holding it (`<plugin>/components/<name>`), else the component's own folder. */
export function commandFolder(component: string): string {
  const parent = dirname(component);
  return basename(parent) === "components" ? dirname(parent) : component;
}

/** The findings of a run of its Command (`checkCommand`'s second half). */
export function commandFindings(command: string, place: string, folderGiven: boolean, outcome: CommandOutcome, timeout: number): Finding[] {
  if (outcome.error === undefined) return [];
  const said = outcome.error.split("\n").map((line) => trimSpaces(line)).filter(Boolean).join(" · ");
  if (outcome.timedOut) {
    return [{ level: "warning", place: "command", text: `Its Command (${command}) did not finish within ${Math.trunc(timeout)}s in ${place}; the chat gives it ${Math.trunc(COMMAND_TIMEOUT_MS / 1000)}s: ${said}` }];
  }
  let text = `Its Command failed when run as written (${command}, in ${place}): ${said}. The app runs the Command: line verbatim with zsh, so it must work exactly as written; describe optional arguments in about.md's prose, not in the line.`;
  if (!folderGiven) text += " If it only works in a project, run the shot again with --folder <project folder>.";
  return [{ level: "problem", place: "command", text }];
}

/**
 * Runs the component's about.md `Command:` line once, verbatim, the way a chat card does (the core's
 * `execute`: the user's zsh, or /bin/sh with BOTLING_PLAIN_SHELL=1, no input, the same output cap) in
 * `folder` (else `commandFolder`), with a shorter time limit. Null when it has no Command.
 */
export async function checkCommand(component: string, folder: string | null, timeout = COMMAND_CHECK_TIMEOUT): Promise<CommandCheck | null> {
  let about: string;
  try { about = readFileSync(resolve(component, "about.md"), "utf8"); } catch { return null; }
  const command = aboutLine(about, "command:");
  if (!command) return null;
  const place = folder ?? commandFolder(component);
  const outcome = await execute(command, place, timeout * 1000, OUTPUT_LIMIT);
  return { command, folder: place, outcome, findings: commandFindings(command, place, folder !== null, outcome, timeout) };
}

/** The data the component is drawn with, where it is from and the notes the summary gives (`ComponentShotRun.run`'s first part). */
export async function resolveData(options: ShotOptions): Promise<{ data: string; source: DataSource; check: CommandCheck | null; notes: string[]; findings: Finding[] } | { error: string }> {
  // Its Command runs once as written, as a chat card runs it, whatever the data is from: a line the
  // shell cannot run is a problem here, not a "The command failed" card later.
  const check = await checkCommand(options.component, options.folder);
  const findings = [...(check?.findings ?? [])];
  const notes: string[] = [];
  if (check && check.outcome.error === undefined) notes.push(`Its Command ran as written in ${check.folder}.`);
  if (options.data) {
    let text: string;
    try { text = readFileSync(options.data, "utf8"); } catch { return { error: `Cannot read ${options.data}.` }; }
    if (!isJSON(text.trim())) return { error: `${options.data} is not JSON.` };
    return { data: text.trim(), source: { kind: "file", path: options.data }, check, notes, findings };
  }
  if (options.folder !== null && check && check.outcome.data !== undefined) {
    return { data: check.outcome.data, source: { kind: "command", command: check.command }, check, notes, findings };
  }
  let about: string | null = null;
  try { about = readFileSync(resolve(options.component, "about.md"), "utf8"); } catch { /* none */ }
  const sample = about === null ? null : sampleData(about);
  if (sample !== null) {
    if (check && options.folder === null) notes.push("It has a Command; pass --folder <project> to draw what the command prints.");
    return { data: sample, source: { kind: "example" }, check, notes, findings };
  }
  return { data: "null", source: { kind: "none" }, check, notes, findings };
}

// ---------------------------------------------------------------------------------------------
// Measuring

/** What the probe in a component frame saw (`PROBE_SCRIPT`). */
export interface FrameReport {
  surface: string;
  size: string;
  width: number;
  height: number;
  /** The document's scroll size: wider than `width` means it is cut off on the right. */
  scrollWidth: number;
  scrollHeight: number;
  /** How tall `#ccb-root`'s content is. */
  contentHeight: number;
  /** The element reaching furthest right past the frame, and how far it reaches. */
  widest?: string | null;
  widestRight?: number | null;
  hasText: boolean;
  hasMedia: boolean;
  errors: string[];
  rejections: string[];
  console: string[];
  ccb: string[];
  resources: string[];
}

/** WebKit hid an uncaught error's words in a sandboxed frame ("Script error."); Chromium shows a frame its own errors. */
export const hasMaskedErrors = (report: FrameReport) => report.errors.some((error) => error.startsWith("Script error."));

/** How many px past the frame still count as fitting (sub-pixel rounding). */
const SLACK = 1;

/** One line: an error's stack lines follow it after " · ", at most 600 characters. */
function short(text: string): string {
  const line = text.split("\n").map((part) => trimSpaces(part)).filter(Boolean).join(" · ");
  const characters = [...line];
  return characters.length > 600 ? `${characters.slice(0, 600).join("")}…` : line;
}

/** What is wrong with one drawn frame (`judge`). `uniform`: its picture is (nearly) one colour. */
export function judge(report: FrameReport, place: string, uniform: boolean): Finding[] {
  const findings: Finding[] = [];
  const problem = (text: string) => findings.push({ level: "problem", place, text });
  for (const error of report.errors) problem(`Script error: ${short(error)}`);
  for (const reason of report.rejections) problem(`Unhandled promise rejection: ${short(reason)}`);
  for (const line of report.console) problem(`console.error: ${short(line)}`);
  for (const line of report.ccb) problem(short(line));
  for (const resource of report.resources) problem(`Did not load: ${short(resource)} (components cannot load outside resources; use data: URLs or ccb.image)`);
  if (report.scrollWidth > report.width + SLACK) {
    let text = `Wider than its frame: ${Math.trunc(report.scrollWidth)}px of content in ${Math.trunc(report.width)}px, cut off on the right`;
    if (report.widest != null && report.widestRight != null) text += ` (widest: ${report.widest}, reaching ${Math.trunc(report.widestRight)}px)`;
    problem(text);
  }
  if (report.contentHeight < 2) {
    problem(`Draws nothing: its content is ${Math.trunc(report.contentHeight)}px tall`);
  } else if (uniform && !report.hasText && !report.hasMedia) {
    problem("Looks blank: one flat colour, no text or pictures");
  }
  if (report.surface === "board" && report.scrollHeight > report.height + SLACK) {
    findings.push({ level: "warning", place, text: `Taller than its tile: ${Math.trunc(report.scrollHeight)}px of content in ${Math.trunc(report.height)}px, the rest is cut off (collapse to a summary when short)` });
  }
  return findings;
}

/** Whether a picture's pixels are (nearly) all one colour: 4 bytes a pixel, the first three its colour (RGBA or BGRA alike). */
export function isUniform(pixels: Uint8Array | number[], tolerance = 10, share = 0.995): boolean {
  const count = Math.floor(pixels.length / 4);
  if (count === 0) return true;
  // The most common colour, coarsely bucketed, against every pixel.
  const buckets = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const key = ((pixels[i * 4]! >> 4) << 8) | ((pixels[i * 4 + 1]! >> 4) << 4) | (pixels[i * 4 + 2]! >> 4);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let top = -1;
  let most = -1;
  for (const [key, value] of buckets) if (value > most) { most = value; top = key; }
  const base = [((top >> 8) & 15) * 16 + 8, ((top >> 4) & 15) * 16 + 8, (top & 15) * 16 + 8];
  let near = 0;
  for (let i = 0; i < count; i++) {
    if ([0, 1, 2].every((c) => Math.abs(pixels[i * 4 + c]! - base[c]!) <= tolerance + 8)) near++;
  }
  return near / count >= share;
}

// ---------------------------------------------------------------------------------------------
// Reporting

export interface Shot { place: string; path: string }

/** The same finding in several places once, with the places joined, in first-seen order. */
function grouped(findings: Finding[]): { places: string; text: string }[] {
  const places = new Map<string, string[]>();
  for (const finding of findings) {
    const list = places.get(finding.text) ?? [];
    if (!list.includes(finding.place)) list.push(finding.place);
    places.set(finding.text, list);
  }
  return [...places].map(([text, list]) => ({ places: list.join(", "), text }));
}

/** What is printed: the verdict, each finding, and where the pictures are; the contact sheet also as a Markdown picture, ready to paste into a chat reply. */
export function summary(component: string, data: DataSource, findings: Finding[], shots: Shot[], sheet: string | null, notes: string[] = []): string {
  const problems = findings.filter((finding) => finding.level === "problem");
  const warnings = findings.filter((finding) => finding.level === "warning");
  const lines = [`Component ${component}: ${shots.length} frame${shots.length === 1 ? "" : "s"} drawn (dark theme; data from ${sourceText(data)}).`];
  lines.push(...notes);
  lines.push(problems.length ? `Problems (${problems.length}):` : "No problems.");
  lines.push(...grouped(problems).map((entry) => `  ✗ ${entry.places}: ${entry.text}`));
  if (warnings.length) {
    lines.push(`Warnings (${warnings.length}):`);
    lines.push(...grouped(warnings).map((entry) => `  ! ${entry.places}: ${entry.text}`));
  }
  if (sheet !== null) {
    lines.push(`Contact sheet: ${sheet}`);
    lines.push(`  Markdown: ![${component}](${sheet})`);
  }
  if (shots.length) {
    lines.push("Pictures:");
    lines.push(...shots.map((shot) => `  ${shot.place}: ${shot.path}`));
  }
  return lines.join("\n");
}

/** A file-safe name for a place: "board 2x1" → "board-2x1". */
export const fileName = (place: string) => place.replaceAll(" ", "-");

/** The finding for a surface on which no frame was drawn (`ComponentShotRun.run`). */
export function notDrawn(surface: Surface, data: string): Finding {
  // With no data a chat card says "Nothing to show" instead of drawing the component.
  const empty = data === "null" && surface === "chat";
  return {
    level: empty ? "warning" : "problem", place: surface,
    text: empty ? "Not drawn: with null data the chat shows \"Nothing to show\" (give --data or add an example to about.md)" : "No component frame was drawn on this surface",
  };
}

/** A frame on the page that never reported. */
export const neverLoaded = (place: string): Finding => ({ level: "problem", place, text: "The frame never finished loading (its page did not reach load within a few seconds)" });

// ---------------------------------------------------------------------------------------------
// The probe

/**
 * Runs first in every component page shot mode serves (main puts it at the top of the page's head). It
 * records errors, unhandled rejections, console.error, failed or unknown `ccb` calls and resources that
 * did not load, and measures the frame when main asks (`window.__ccbShotMeasure()`, read with
 * executeJavaScript in that frame once the page has drawn). 1.x's `probeScript`, with main reading the
 * report instead of the frame posting it to `webkit.messageHandlers.ccbShot`.
 */
export const PROBE_SCRIPT = String.raw`(() => {
  const report = {errors: [], rejections: [], console: [], ccb: [], resources: []};
  const text = (value) => {
    try {
      if (value instanceof Error) return value.name + ': ' + value.message + (value.stack ? '\n' + String(value.stack).split('\n').slice(0, 4).join('\n') : '');
      if (value && typeof value === 'object') return JSON.stringify(value);
      return String(value);
    } catch (error) { return String(value); }
  };
  const where = (element) => {
    let name = element.tagName.toLowerCase();
    if (element.id) name += '#' + element.id;
    const classes = [...element.classList].slice(0, 2);
    if (classes.length) name += '.' + classes.join('.');
    return name;
  };
  let loaded = false;
  const measure = () => {
    const root = document.getElementById('ccb-root');
    if (!root || !loaded) return null;
    const html = document.documentElement;
    const width = window.innerWidth, height = window.innerHeight;
    let widest = null, widestRight = 0, bottom = 0;
    for (const element of root.querySelectorAll('*')) {
      const box = element.getBoundingClientRect();
      if (!box.width && !box.height) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      bottom = Math.max(bottom, box.bottom);
      if (box.right > width + 1 && box.right > widestRight) { widest = where(element); widestRight = box.right; }
    }
    const media = [...root.querySelectorAll('img,svg,canvas,video,picture,iframe')].some((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 4 && box.height > 4;
    });
    return JSON.parse(JSON.stringify({
      surface: html.dataset.surface || '', size: html.dataset.size || '',
      width, height,
      scrollWidth: Math.max(html.scrollWidth, document.body ? document.body.scrollWidth : 0),
      scrollHeight: Math.max(html.scrollHeight, document.body ? document.body.scrollHeight : 0),
      contentHeight: Math.max(root.getBoundingClientRect().height, bottom - root.getBoundingClientRect().top),
      widest, widestRight: widest ? widestRight : null,
      hasText: (root.innerText || '').trim().length > 0,
      hasMedia: media,
      ...report
    }));
  };
  Object.defineProperty(window, '__ccbShotMeasure', {value: measure, configurable: false, writable: false, enumerable: false});
  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window && target.tagName) {
      report.resources.push(target.tagName.toLowerCase() + ' ' + (target.currentSrc || target.src || target.href || ''));
    } else {
      report.errors.push(event.error ? text(event.error) : (event.message || 'Error') + (event.lineno ? ' (line ' + event.lineno + ')' : ''));
    }
  }, true);
  window.addEventListener('unhandledrejection', (event) => { report.rejections.push(text(event.reason)); });
  // A picture or font the CSP refused never fires an error event in Chromium: it is reported here.
  document.addEventListener('securitypolicyviolation', (event) => {
    if (event.disposition === 'enforce' && /^(img|font|media|style|connect|frame|child|worker|object|manifest|prefetch)-src/.test(event.effectiveDirective) && event.blockedURI && !/^(inline|eval)$/.test(event.blockedURI)) {
      const entry = event.effectiveDirective.replace(/-src.*$/, '') + ' ' + event.blockedURI;
      if (!report.resources.includes(entry)) report.resources.push(entry);
    }
  });
  const original = console.error.bind(console);
  console.error = (...values) => { report.console.push(values.map(text).join(' ')); original(...values); };
  // window.ccb: a call that throws or rejects, or a name ccb does not have, is reported.
  const quiet = new Set(['then', 'toJSON', 'constructor', 'valueOf', 'toString', 'nodeType', 'length', 'inspect']);
  const wrap = (api) => {
    if (!api || typeof api !== 'object') return api;
    return new Proxy(api, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof key !== 'string') return value;
        if (!(key in target)) {
          if (!quiet.has(key)) report.ccb.push('ccb.' + key + ' is not part of ccb (see PLUGINS.md for the API)');
          return value;
        }
        if (typeof value !== 'function') return value;
        return function (...values) {
          let result;
          try { result = value.apply(this === receiver ? target : this, values); }
          catch (error) { report.ccb.push('ccb.' + key + ' threw: ' + text(error)); throw error; }
          if (result && typeof result.then === 'function') {
            result.then(null, (error) => { report.ccb.push('ccb.' + key + ' failed: ' + text(error)); });
          }
          return result;
        };
      }
    });
  };
  let api;
  Object.defineProperty(window, 'ccb', {configurable: true, enumerable: true, get() { return api; }, set(value) { api = wrap(value); }});
  const settle = () => setTimeout(() => { loaded = true; }, 1200);
  if (document.readyState === 'complete') settle();
  else window.addEventListener('load', settle);
})();`;

/** A component page with the probe first in its head (only component pages: they hold `id="ccb-root"`). */
export function withProbe(html: string): string {
  if (!html.includes('id="ccb-root"')) return html;
  const script = `<script>${PROBE_SCRIPT}</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length);
  return script + html;
}

/** Read in the chat page: each component frame's place on the page, its HTML (what Web/src gave it as srcdoc), surface and size (1.x's `framesScript`). */
export const FRAMES_SCRIPT = String.raw`(() => [...document.querySelectorAll('iframe')]
  .filter((frame) => (frame.srcdoc || '').includes('id="ccb-root"'))
  .map((frame) => {
    const box = frame.getBoundingClientRect();
    const head = frame.srcdoc.slice(0, 400);
    return {
      x: box.left, y: box.top, width: box.width, height: box.height,
      surface: (head.match(/data-surface="([^"]*)"/) || [])[1] || '',
      size: (head.match(/data-size="([^"]*)"/) || [])[1] || '',
      src: frame.getAttribute('src') || ''
    };
  })
  .filter((frame) => frame.width > 0 && frame.height > 0))()`;
