// elkjs 0.12.0 exposes this in-process FakeWorker at runtime, but ships no
// declaration for the minified entry. Describe only the protocol reports use;
// the public elk-api constructor is asynchronous and is not this constructor.
declare module 'elkjs/lib/elk-worker.min.js' {
  import type { ElkNode } from 'elkjs/lib/elk-api';

  type Request =
    | { id: number; cmd: 'register'; algorithms: string[] }
    | { id: number; cmd: 'layout'; graph: ElkNode };
  type Reply = { id: number; data?: ElkNode; error?: unknown };

  export class Worker {
    constructor(url?: string);
    onmessage?: (event: { data: Reply }) => void;
    dispatcher: { saveDispatch(event: { data: Request }): void };
  }
}
