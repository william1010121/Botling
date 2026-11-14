import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { PREVIEW_CSP, PREVIEW_TYPES } from './card-page';

/** How a file is served when it is not a preview card's: its type, its page policy, and whether a symlink is followed. */
/** `html`: rewrites an HTML page before it is sent (whole, never in byte ranges), e.g. the report theme. */
export interface ServeOptions { type?: string; csp?: string; follow?: boolean; html?: (text: string) => string }

/** The headers of a served file: its type (with `charset=utf-8` when a text type's first 64 KiB decode as UTF-8, tolerating only a cut-off trailing code point), its page policy, no sniffing, no caching, byte ranges. */
export async function fileHeaders(handle: FileHandle, size: number, type: string, csp?: string): Promise<Headers> {
  let contentType = type;
  if ((/^text\//.test(type) || ['application/javascript','application/json','image/svg+xml'].includes(type))) {
    const bytes = Buffer.alloc(Math.min(size, 65536)); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    try { new TextDecoder('utf-8', {fatal:true}).decode(bytes.subarray(0, bytesRead), {stream:bytesRead < size}); contentType += '; charset=utf-8'; } catch { /* use the page's own encoding */ }
  }
  return new Headers({'Content-Type':contentType,'Content-Security-Policy':csp ?? PREVIEW_CSP,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Accept-Ranges':'bytes'});
}

/**
 * The byte-range part of a file response (one `bytes=` range, as 1.x): 200 with the whole file, 206 with
 * `Content-Range`, or 416 with `bytes *\/size`. `body(start, end)` (inclusive) is called only when bytes are sent: not
 * for HEAD, an empty file or a 416. Shared by the preview and chat origins and Botling 3's content protocol.
 */
export function rangedResponse(request: Request, size: number, headers: Headers, body: (start: number, end: number) => ReadableStream<Uint8Array>): Response {
  let start=0,end=size-1,status=200;
  const range=request.headers.get('range');
  if (range) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    let valid=!!match && !!(match[1] || match[2]) && size>0;
    if (valid && match) {
      if (!match[1]) {const suffix=Number(match[2]); valid=Number.isSafeInteger(suffix)&&suffix>0; start=Math.max(0,size-suffix);}
      else {start=Number(match[1]);end=match[2]?Number(match[2]):size-1;valid=Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start<size&&end>=start;end=Math.min(end,size-1);}
    }
    if (!valid) {headers.set('Content-Range',`bytes */${size}`);headers.set('Content-Length','0');return new Response(null,{status:416,headers});}
    status=206; headers.set('Content-Range',`bytes ${start}-${end}/${size}`);
  }
  headers.set('Content-Length',String(Math.max(0,end-start+1)));
  if (request.method==='HEAD' || size===0) return new Response(null,{status,headers});
  return new Response(body(start,end),{status,headers});
}

/** Streaming local preview response. Sniff at most 64 KiB of text, tolerating only a cut-off trailing code point. */
export async function previewResponse(file: string, request: Request, options: ServeOptions = {}): Promise<Response> {
  const handle = await open(file, options.follow ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW);
  let streamed = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return new Response('Not found', { status: 404 });
    const size = stat.size;
    const type = options.type ?? PREVIEW_TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
    const headers = await fileHeaders(handle, size, type, options.csp);
    if (options.html && type === 'text/html' && size <= 64 << 20) {
      const text = new TextDecoder('utf-8').decode((await handle.readFile()));
      const body = new TextEncoder().encode(options.html(text));
      headers.set('Content-Type', 'text/html; charset=utf-8'); headers.delete('Accept-Ranges'); headers.set('Content-Length', String(body.byteLength));
      return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
    }
    return rangedResponse(request, size, headers, (start, end) => {
      streamed = true;
      return Readable.toWeb(handle.createReadStream({start,end,autoClose:true})) as ReadableStream<Uint8Array>;
    });
  } finally {if(!streamed)await handle.close();}
}
