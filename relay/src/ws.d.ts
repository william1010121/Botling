// The few parts of `ws` the relay and its tests use (keeps the image free of @types packages).
declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';
  import { EventEmitter } from 'node:events';
  export class WebSocket extends EventEmitter {
    constructor(url: string, options?: { headers?: Record<string, string> });
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(): void;
  }
  export class WebSocketServer extends EventEmitter {
    constructor(options: { noServer: true; maxPayload?: number; perMessageDeflate?: boolean });
    readonly clients: Set<WebSocket>;
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, done: (ws: WebSocket) => void): void;
    close(): void;
  }
  export default WebSocket;
}
