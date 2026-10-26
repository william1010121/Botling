// Hooks over the page's `ccb` runtime (Web/src/components.ts componentPage): its data, its size
// and where it is drawn, each redrawing the component when it changes.
import { useEffect, useState } from "preact/hooks";

const none = Object.freeze({});
const ccb = () => window.ccb || {};

/**
 * The card's data (`ccb.data`), and again whenever new data comes (`ccb.onData`: its command ran
 * again, a pin refreshed, the bot updated it; the frame is kept and only redraws). `{}` when there
 * is none, so `d.field` never throws.
 */
export function useData() {
  const [data, setData] = useState(() => ccb().data);
  useEffect(() => {
    const runtime = ccb();
    if (typeof runtime.onData !== "function") return undefined;
    const stop = runtime.onData((next) => setData(next));
    return typeof stop === "function" ? stop : undefined;
  }, []);
  return data == null ? none : data;
}

const fallback = Object.freeze({ w: 2, h: 2, name: "large", px: Object.freeze({ width: 0, height: 0 }) });

/** The size it is drawn at (`ccb.size`: `{w, h, name, px: {width, height}}`), kept up to date (`ccb.onSize`). */
export function useSize() {
  const [size, setSize] = useState(() => ccb().size || fallback);
  useEffect(() => {
    const runtime = ccb();
    if (typeof runtime.onSize !== "function") return undefined;
    const stop = runtime.onSize((next) => setSize(next));
    return typeof stop === "function" ? stop : undefined;
  }, []);
  return size;
}

/** Where it is drawn: "chat", "board" or "pinned" (`ccb.surface`). */
export function useSurface() {
  return ccb().surface || document.documentElement.dataset.surface || "chat";
}
