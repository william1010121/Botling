// The phone web app (desktop/mobile/dist), served under /mobile/ when STATIC_DIR is set. The same headers the
// desktop's own bridge sends (desktop/src/mobile-bridge/bridge.ts: webChatCSP, frameHostCSP): the chat page runs
// in a sandboxed, opaque-origin frame with no network; only the shell talks to this relay, over its WebSocket.
// Note: whoever serves this code can change it. The threat model (docs/mobile-relay.md) says what that means.
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json',
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

export async function serveStatic(dir: string, origin: string, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith('/mobile/')) return false;
  let name: string;
  try { name = decodeURIComponent(pathname.slice('/mobile/'.length)) || 'index.html'; } catch { return false; }
  if (name.includes('\0') || name.split('/').some(part => part === '..' || part.startsWith('.'))) return false;
  const root = normalize(dir + sep);
  const file = normalize(join(root, name));
  if (!file.startsWith(root)) return false;
  const type = TYPES[extname(file)];
  if (!type) return false;
  try {
    if (!(await stat(file)).isFile()) return false;
    const body = await readFile(file);
    const base = name.split('/').pop();
    res.setHeader('Content-Security-Policy', base === 'chat.html' ? webChatCSP(origin) : base === 'frame-host.html' ? frameHostCSP(origin) : shellCSP);
    if (extname(file) === '.woff2') res.setHeader('Access-Control-Allow-Origin', '*'); // the sandboxed chat frame's fonts (Origin: null)
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  } catch { return false; }
}
