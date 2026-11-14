// The front-end link's dial over botlingd's local Unix socket (protocol v1 §5.2, §6.1): each frame is a 4-byte
// big-endian length and the JSON text. Node only (no Electron), so tests run it against a plain `net` server.
import { createConnection } from "node:net";
import { FrameSplitter, packFrame } from "../protocol/frame";
import type { Dial } from "../fe-link";

export interface UnixDialOptions {
  path: string;
  /** Told why a dial failed (ENOENT / ECONNREFUSED: no server listening). */
  onError?: (error: NodeJS.ErrnoException) => void;
}

export function unixDial(options: UnixDialOptions): Dial {
  return (handlers) => {
    const socket = createConnection(options.path);
    const splitter = new FrameSplitter();
    let closed = false;
    const close = (detail?: string) => {
      if (closed) return;
      closed = true;
      socket.destroy();
      handlers.close(detail);
    };
    socket.on("connect", () => { if (!closed) handlers.open(); });
    socket.on("data", (chunk: Buffer) => {
      if (closed) return;
      const split = splitter.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (!split.ok) { close(split.detail); return; }
      for (const frame of split.frames) { if (closed) return; handlers.frame(frame); }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => { options.onError?.(error); close(error.code ?? error.message); });
    socket.on("close", () => close("closed"));
    return {
      send(frame: string) { if (!closed) socket.write(packFrame(frame)); },
      close() { close("closed by the front end"); },
    };
  };
}
