// botlingd's local socket (M1 step 9, protocol v1 §6.1): a Unix socket only the user can open (mode 0600, in a folder
// that is 0700), one Session per connection. A socket file left by a botlingd that died is removed when nothing answers
// on it; one that answers belongs to a running botlingd (the data-folder lock refuses a second one before this).
import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { Session, type SessionHost, type SessionOptions } from "./session";

/** True when something accepts connections on `path`. */
export function socketAnswers(path: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (answer: boolean) => { if (done) return; done = true; socket.destroy(); resolve(answer); };
    const socket: Socket = createConnection(path);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    setTimeout(() => finish(false), timeoutMs).unref?.();
  });
}

export class SessionServer {
  private server: Server | null = null;
  private readonly sessions = new Set<Session>();

  constructor(private readonly path: string, private readonly host: SessionHost, private readonly options: SessionOptions = {}) {}

  get open(): Session[] { return [...this.sessions].filter((session) => session.isOpen); }

  async listen(): Promise<void> {
    if (existsSync(this.path)) {
      if (!lstatSync(this.path).isSocket()) throw new Error(`${this.path} exists and is not a socket`);
      if (await socketAnswers(this.path)) throw new Error(`another botlingd answers on ${this.path}`);
      rmSync(this.path, { force: true });
    }
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    // The socket is made 0600 from the start (no moment where another user could connect), then chmod'ed to be sure.
    const mask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.path, () => { server.off("error", reject); resolve(); });
      });
    } finally {
      process.umask(mask);
    }
    chmodSync(this.path, 0o600);
    server.on("error", (error) => this.host.log(`socket: ${error.message}`));
  }

  /** Every session gets a `bye{closing}`, then the socket file goes. */
  async close(): Promise<void> {
    for (const session of [...this.sessions]) session.bye("closing", "botlingd is stopping");
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(this.path, { force: true });
  }

  private accept(socket: Socket): void {
    const session = new Session(socket, this.host, this.options);
    this.sessions.add(session);
    session.onClosed(() => this.sessions.delete(session));
  }
}
