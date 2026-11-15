// Static phone web apps served by the relay:
// - /mobile/ (2.x desktop/mobile/dist) when STATIC_DIR is set: headers match desktop/src/mobile-bridge/bridge.ts.
// - /v3/ (3.x desktop/web-v3/dist) when STATIC_V3_DIR is set (D22, §6.3): CSP matches desktop/src/server/net/http.ts
//   with connect-src 'self' (the relay's own WebSocket), keeping /mobile/ and /v3/ in separate service-worker scopes.
// Note: whoever serves this code can change it. The threat model (docs/mobile-relay.md) says what that means.
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json',
};

// web-v3/build.mjs also emits pdf.worker.mjs, sourcemaps, and pdfjs cmaps/fonts/license files; no .wasm is used.
const V3_TYPES: Record<string, string> = {
  ...TYPES,
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
};

export const webChatCSP = (origin: string) => [
  "default-src 'none'", "script-src 'self' blob:", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
  "media-src 'self' data: blob:", `frame-src ${origin}/mobile/frame-host.html`, "connect-src 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-ancestors 'self'",
].join('; ');
export const frameHostCSP = (origin: string) => [
  'sandbox allow-scripts', "default-src 'none'", `script-src ${origin}/mobile/frame-host.js 'unsafe-inline' blob:`, "style-src 'unsafe-inline'",
  'img-src data: blob:', 'font-src data:', 'media-src data: blob:', "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'",
  "form-action 'none'", "base-uri 'none'",
].join('; ');
/** The shell: its scripts and styles from here, network only to this origin (the relay's WebSocket). */
export const shellCSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
  "connect-src 'self'", "frame-src 'self'", "manifest-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-ancestors 'none'",
].join('; ');

/** Must match desktop/src/server/net/http.ts CSP (connect-src 'self' for the relay's own WebSocket). */
export const v3CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
/** Must match desktop/src/server/net/http.ts CHAT_CSP. */
export const v3ChatCSP = [
  "default-src 'none'", "script-src 'self' blob:", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
  "media-src 'self' data: blob:", "frame-src 'self'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-ancestors 'self'",
].join('; ');
/** Must match desktop/src/server/net/http.ts FRAME_HOST_CSP. */
export const v3FrameHostCSP = [
  "sandbox allow-scripts", "default-src 'none'", "script-src 'self' 'unsafe-inline' blob:", "style-src 'unsafe-inline'", "img-src data: blob:",
  "font-src data:", "media-src data: blob:", "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'",
].join('; ');

async function readSafeFile(
  dir: string,
  prefix: string,
  pathname: string,
  types: Record<string, string>,
): Promise<{ name: string; ext: string; type: string; body: Buffer } | null> {
  if (!pathname.startsWith(prefix)) return null;
  let name: string;
  try { name = decodeURIComponent(pathname.slice(prefix.length)) || 'index.html'; } catch { return null; }
  if (name.includes('\0') || name.includes('\\') || name.split('/').some(part => part === '' || part.startsWith('.'))) return null;
  try {
    const root = await realpath(dir);
    const rootPrefix = root.endsWith(sep) ? root : root + sep;
    const candidate = normalize(join(rootPrefix, name));
    if (!candidate.startsWith(rootPrefix)) return null;
    const file = await realpath(candidate);
    if (!file.startsWith(rootPrefix)) return null;
    const ext = extname(file).toLowerCase();
    const type = types[ext];
    if (!type) return null;
    if (!(await stat(file)).isFile()) return null;
    return { name, ext, type, body: await readFile(file) };
  } catch { return null; }
}

export async function serveStatic(dir: string, origin: string, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const found = await readSafeFile(dir, '/mobile/', pathname, TYPES);
  if (!found) return false;
  const base = found.name.split('/').pop();
  res.setHeader('Content-Security-Policy', base === 'chat.html' ? webChatCSP(origin) : base === 'frame-host.html' ? frameHostCSP(origin) : shellCSP);
  if (found.ext === '.woff2') res.setHeader('Access-Control-Allow-Origin', '*'); // the sandboxed chat frame's fonts (Origin: null)
  res.writeHead(200, { 'Content-Type': found.type, 'Content-Length': found.body.length });
  res.end(req.method === 'HEAD' ? undefined : found.body);
  return true;
}

export async function serveStaticV3(dir: string, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const found = await readSafeFile(dir, '/v3/', pathname, V3_TYPES);
  if (!found) return false;
  res.setHeader(
    'Content-Security-Policy',
    found.name === 'chat.html' ? v3ChatCSP : found.name === 'frame-host.html' ? v3FrameHostCSP : v3CSP,
  );
  if (found.ext === '.woff2') res.setHeader('Access-Control-Allow-Origin', '*'); // the sandboxed chat frame's fonts (Origin: null)
  res.writeHead(200, { 'Content-Type': found.type, 'Content-Length': found.body.length });
  res.end(req.method === 'HEAD' ? undefined : found.body);
  return true;
}
