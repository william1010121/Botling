import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { PREVIEW_CSP, PREVIEW_TYPES } from './card-page';

/** Streaming local preview response. Only a small, complete text file is sniffed as UTF-8. */
export async function previewResponse(file: string, request: Request): Promise<Response> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let streamed = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return new Response('Not found', { status: 404 });
    const size = stat.size;
    const type = PREVIEW_TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
    let contentType = type;
    if (size <= 65536 && (/^text\//.test(type) || ['application/javascript','application/json','image/svg+xml'].includes(type))) {
      const bytes = Buffer.alloc(size); await handle.read(bytes, 0, size, 0);
      try { new TextDecoder('utf-8', {fatal:true}).decode(bytes); contentType += '; charset=utf-8'; } catch { /* use the page's own encoding */ }
    }
    const headers = new Headers({'Content-Type':contentType,'Content-Security-Policy':PREVIEW_CSP,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Accept-Ranges':'bytes'});
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
    const body=Readable.toWeb(handle.createReadStream({start,end,autoClose:true})) as ReadableStream<Uint8Array>;
    streamed=true;return new Response(body,{status,headers});
  } finally {if(!streamed)await handle.close();}
}
