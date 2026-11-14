// The part of `ws` 8.22 (a direct dependency since M2 step 6, the same version as relay/) that server/net uses. The
// package ships no types and @types/ws is not a dependency, so this states the calls botlingd makes.
declare module "ws" {
  import type { EventEmitter } from "node:events";
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export interface ServerOptions {
    noServer?: boolean;
    maxPayload?: number;
    perMessageDeflate?: boolean;
    clientTracking?: boolean;
    skipUTF8Validation?: boolean;
  }

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
    /** The client side (tests dial with it). */
    constructor(address: string, options?: { origin?: string; headers?: Record<string, string> });
    readonly readyState: 0 | 1 | 2 | 3;
    readonly bufferedAmount: number;
    binaryType: "nodebuffer" | "arraybuffer" | "fragments";
    send(data: Uint8Array | string, options?: { binary?: boolean }, callback?: (error?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: "message", listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: ServerOptions);
    readonly clients: Set<WebSocket>;
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WebSocket, request: IncomingMessage) => void): void;
    close(callback?: (error?: Error) => void): void;
  }
}
