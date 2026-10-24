// Components pinned to a bot (the Swift app's Pins.swift): a chip above its input box and a card
// on its Board, kept in the bot's pins.json in 1.x's format (dates as Swift dates, ids upper case).
// A pin with a command is drawn again with what the command prints (when shown, every so often, or
// only on ↻) once the user allowed that command for the bot's folder, as any component card; one
// without keeps the data it was last drawn (or saved, `ccb.save`) with.
import { characterCount, characterPrefix } from "../briefing";

export type PinRefresh = "shown" | "interval" | "manual";
export type Corner = "topRight" | "topLeft" | "bottomRight" | "bottomLeft";
export type Tone = "neutral" | "good" | "warning" | "bad";

export interface PinFloat { corner: Corner; width?: number; height?: number; collapsed: boolean }

export interface PinRecord {
  id: string;
  name: string;
  command?: string;
  data: string;
  ranAt?: number;
  refresh: PinRefresh;
  minutes: number;
  seconds?: number;
  size: string;
  place?: { col: number; row: number };
  panelHeight?: number;
  status?: { text: string; tone: Tone };
  savedAt?: number;
  makingLive: boolean;
  float?: PinFloat;
  [key: string]: unknown;
}

export const DEFAULT_MINUTES = 15;
export const SHOWN_COOLDOWN_MS = 30_000;
export const MAX_FLOATING = 2;
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(Math.round(value), low), high);
export const clampMinutes = (minutes: number) => clamp(minutes, 1, 24 * 60);
export const clampSeconds = (seconds: number) => clamp(seconds, 2, 24 * 60 * 60);
export const clampPanelHeight = (height: number | null | undefined) => (typeof height === "number" && Number.isFinite(height) ? clamp(height, 120, 1600) : undefined);

/** A tone as a component may spell it (`PinStatus.Tone(spelled:)`). */
export function spelledTone(text: string | null | undefined): Tone {
  switch ((text ?? "").trim().toLowerCase()) {
    case "good": case "ok": case "success": case "green": case "done": return "good";
    case "warning": case "warn": case "yellow": case "orange": case "pending": return "warning";
    case "bad": case "error": case "danger": case "red": case "fail": case "failed": return "bad";
    default: return "neutral";
  }
}

const firstLine = (text: string) => text.split(/\r?\n|\r/).map((line) => line.trim()).find(Boolean) ?? "";
const clip = (text: string, limit: number) => (characterCount(text) > limit ? `${characterPrefix(text, limit - 1)}…` : text);

/** `text`'s first line cut to a chip's 14 characters (`Pins.short`). */
export function short(text: string): string {
  const line = firstLine(text);
  if (characterCount(line) <= 14) return line;
  return `${characterPrefix(line, 13).trim()}…`;
}

/** One short line from the shape of a pin's data (`Pins.headline`). */
export function headline(json: string, limit = 48): string {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return clip(firstLine(json), limit); }
  return clip(headlineOf(value, 0), limit);
}

function headlineOf(value: unknown, depth: number): string {
  if (typeof value === "string") return firstLine(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (!value.length) return "Nothing yet";
    const line = depth < 2 ? headlineOf(value[0], depth + 1) : "";
    return value.length > 1 && line ? `${line} · ${value.length}` : line;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["summary", "headline", "title"]) {
      const text = object[key];
      if (typeof text === "string" && text.trim()) return firstLine(text);
    }
    const keys = Object.keys(object);
    if (depth < 2) {
      const list = keys.map((key) => object[key]).find(Array.isArray);
      if (list) return headlineOf(list, depth + 1);
    }
    const parts = keys.flatMap((key) => {
      const item = object[key];
      if (typeof item === "string") { const line = firstLine(item); return line ? [line] : []; }
      if (typeof item === "number") return [`${key} ${item}`];
      return [];
    });
    return parts.slice(0, 2).join(" · ");
  }
  return "";
}

/** What a pin's chip shows (`Pins.chip`). */
export function chip(status: PinRecord["status"], line: string, command: string | null, hasData: boolean): { text: string; tone: Tone } {
  if (command === "failed") return { text: "Failed", tone: "bad" };
  if (command === "approve" && !hasData) return { text: "Allow?", tone: "warning" };
  if (command === "running" && !hasData) return { text: "…", tone: "neutral" };
  return status ?? { text: short(line), tone: "neutral" };
}

/** A pin read from pins.json; values this build does not know fall back, so the rest still loads. */
export function readPin(value: unknown): PinRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.name !== "string") return null;
  const sizeText = typeof v.size === "string" ? v.size : "";
  const size = /^[1-4]x[1-4]$/.test(sizeText) ? sizeText : ({ S: "1x1", M: "2x2", L: "4x2", s: "1x1", m: "2x2", l: "4x2" } as Record<string, string>)[sizeText] ?? "2x2";
  const refresh = v.refresh === "shown" || v.refresh === "interval" || v.refresh === "manual" ? v.refresh : "shown";
  const pin: PinRecord = {
    ...(v as object),
    id: v.id, name: v.name, data: typeof v.data === "string" ? v.data : "null",
    refresh, minutes: clampMinutes(typeof v.minutes === "number" ? v.minutes : DEFAULT_MINUTES), size, makingLive: v.makingLive === true,
  } as PinRecord;
  if (typeof v.command !== "string") delete pin.command;
  if (typeof v.seconds === "number") pin.seconds = clampSeconds(v.seconds); else delete pin.seconds;
  const height = clampPanelHeight(v.panelHeight as number);
  if (height !== undefined) pin.panelHeight = height; else delete pin.panelHeight;
  const place = v.place as { col?: unknown; row?: unknown } | undefined;
  if (place && typeof place.col === "number" && typeof place.row === "number") pin.place = { col: Math.max(0, Math.round(place.col)), row: Math.max(0, Math.round(place.row)) };
  else delete pin.place;
  const status = v.status as { text?: unknown; tone?: unknown } | undefined;
  if (status && typeof status === "object") pin.status = { text: short(typeof status.text === "string" ? status.text : ""), tone: spelledTone(typeof status.tone === "string" ? status.tone : null) };
  else delete pin.status;
  const float = v.float as { corner?: unknown; width?: unknown; height?: unknown; collapsed?: unknown } | undefined;
  if (float && typeof float === "object") {
    const corner = ["topRight", "topLeft", "bottomRight", "bottomLeft"].includes(float.corner as string) ? (float.corner as Corner) : "topRight";
    let width = typeof float.width === "number" ? clamp(float.width, 200, 640) : undefined;
    let height2 = typeof float.height === "number" ? clamp(float.height, 100, 480) : undefined;
    if (width === 280 && height2 === 160) { width = undefined; height2 = undefined; }
    pin.float = { corner, ...(width !== undefined ? { width } : {}), ...(height2 !== undefined ? { height: height2 } : {}), collapsed: float.collapsed === true };
  } else delete pin.float;
  if (typeof v.ranAt !== "number") delete pin.ranAt;
  if (typeof v.savedAt !== "number") delete pin.savedAt;
  // A pin without a command never refreshes by itself.
  if (!pin.command) pin.refresh = "manual";
  return pin;
}

/** The float entry in a pin's menu (`Pins.floatMenu`). */
export const floatMenu = (pin: PinRecord, floating: number) => (pin.float ? "stop" : floating >= MAX_FLOATING ? "full" : "float");

/** Whether a pin refreshed every so often is due (`isDue`). */
export function isDue(pin: PinRecord, now: number, lastRan: number | null): boolean {
  if (pin.refresh !== "interval" || !pin.command) return false;
  if (lastRan === null) return true;
  return now - lastRan >= (pin.seconds ?? pin.minutes * 60) * 1000;
}
