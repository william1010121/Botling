// The page a card frame loads from `botling-card://card/<messageId>/<cardId>`: the agent's HTML
// plus a tiny `ccb` runtime, under a CSP that lets its own inline script run but reach nothing —
// no network, no forms, no nested frames. The frame is also `sandbox="allow-scripts"` (opaque
// origin: no cookies, storage or access to the app's page) and has no preload, so `ccb` is all it
// has, and every `ccb` call is a postMessage that the renderer's broker checks.

export const CARD_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * A library component's page (Web/src's `componentPage`): its own inline scripts and styles run,
 * pictures come only as data:/blob: or from botling-card://image/ (pictures its data named), and
 * it reaches nothing else — no network, no frames, no forms, no workers.
 */
export const COMPONENT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob: botling-card:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const runtime = `<script>
(() => {
  let data = null;
  const listeners = [];
  window.addEventListener('message', (event) => {
    if (event.source !== parent || !event.data || typeof event.data.ccbData !== 'string') return;
    try { data = JSON.parse(event.data.ccbData); } catch { return; }
    for (const fn of listeners) { try { fn(data); } catch (error) { console.error(error); } }
  });
  const post = (message) => parent.postMessage(message, '*');
  window.ccb = Object.freeze({
    get data() { return data; },
    onData(fn) { listeners.push(fn); if (data !== null) fn(data); },
    save(value) {
      const json = JSON.stringify(value);
      if (json === undefined || json === 'null') return Promise.reject(new Error('ccb.save needs data (not null or undefined).'));
      data = JSON.parse(json);
      post({ ccb: 'save', data: json });
      return Promise.resolve();
    },
    action(name, value) { post({ ccb: 'action', name: String(name), value: value == null ? '' : String(value) }); },
  });
  const size = () => post({ ccb: 'size', height: Math.min(4000, Math.ceil(document.documentElement.getBoundingClientRect().height)) });
  new ResizeObserver(size).observe(document.documentElement);
  addEventListener('load', size);
})();
</script>`;

const style = `<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; background: transparent; color: #EDEDF0; font: 14px/1.55 -apple-system, "PingFang TC", "Noto Sans TC", "Segoe UI", sans-serif; }
  body { padding: 12px 14px; }
  button { font: inherit; color: #EDEDF0; background: #2C2C33; border: 1px solid #2E2E35; border-radius: 10px; padding: 6px 12px; cursor: pointer; }
  button:hover { background: #33333B; }
  code { background: #111114; padding: 1px 5px; border-radius: 5px; }
  p { margin: 0 0 10px; color: #A0A0A8; }
</style>`;

export function cardPage(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CARD_CSP}">${style}${runtime}</head><body>${html}</body></html>`;
}
