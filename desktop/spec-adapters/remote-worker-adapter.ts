// spec/driver/remote-worker-driver.ts against the real code (spec/models/remoteworker/RemoteWorker.tla).
// The app's side is a real RemoteSession (src/remote/session.ts, not driving itself) over the real MachineStore; the
// machine's side is a real AgentServer (src/remote/agent/server.ts) on a scratch home, with a scripted claude in place of
// the real one. Between them a transport held here: each connection's frames wait in its queues until the test
// delivers them, and a drop or a revoke keeps only the first frames on their way to the agent.
//   The agent's version: "" while none is installed (the model's agv 0: the ssh launcher finds no agent and the app
//   hears an agent of no version), the app's version once Upgrade put it there (one agent stands for the model's one
//   agent; the ssh path's one process per connection and its disk lock are covered by the unit tests).
//   Requests: the scripted claude asks request k with input {k}; the agent names it (q1, q2, … in the order first
//   asked, the same name when a resumed run asks it again); the view maps the app's cards back to k.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteWorkerDriver, RemoteWorkerSession } from "../../spec/driver/remote-worker-driver";
import type { CardState, Path, View } from "../../spec/reference/remote-worker";
import type { HeadConfig, HeadHandlers } from "../src/core/agent/head";
import { AgentServer, type AgentClaude, type AgentLink } from "../src/remote/agent/server";
import { MachineStore } from "../src/remote/machines";
import type { DownFrame, UpFrame } from "../src/remote/protocol";
import { RemoteSession, type LinkHandlers, type SessionLink } from "../src/remote/session";

const SESSION = "worker-1";
const NAME = "box";
const CONFIG: HeadConfig = { command: "claude", cwd: "/project", sessionId: "11111111-1111-4111-8111-111111111111", resume: false, allowedTools: [] };

interface Conn { down: DownFrame[]; up: UpFrame[]; handlers: LinkHandlers; agent: AgentLink }
interface Scripted extends AgentClaude { handlers: HeadHandlers; run: number }

export function remoteWorkerDriver(options: { maxReqs: number }): RemoteWorkerDriver {
  return {
    async open(): Promise<RemoteWorkerSession> {
      const dir = mkdtempSync(join(tmpdir(), "botling-spec-remote-"));
      const machines = new MachineStore(join(dir, "app", "machines.json"));
      let appVersion = "1";
      const claudes = new Map<number, Scripted>();
      const agent = new AgentServer({
        home: join(dir, "agent"), version: "", sha: "",
        spawn: (_config, handlers, { run }) => {
          const claude: Scripted = {
            pid: 10_000 + run, run, handlers,
            start() {}, send() {}, answer() {}, finish() {},
            async terminate() { if (claudes.get(run) === claude) { claudes.delete(run); handlers.onExit({ code: null, signal: "SIGTERM", stderr: "", expected: true, silent: false }); } return {}; },
          };
          claudes.set(run, claude);
          return claude;
        },
        alive: () => false,
        killTree: async () => undefined,
      });
      const conns = new Map<number, Conn>();
      const session = new RemoteSession({
        id: SESSION, auto: false,
        machine: {
          trusted: () => machines.find(NAME)?.trust === "trusted",
          epoch: () => machines.find(NAME)?.epoch ?? 0,
          name: () => NAME,
        },
        transport: {
          open(_s: string, g: number, handlers: LinkHandlers): SessionLink {
            const conn: Conn = { down: [], up: [], handlers, agent: undefined as unknown as AgentLink };
            conn.agent = agent.connect((frame) => conn.up.push(frame));
            conns.set(g, conn);
            return {
              send: (frame) => conn.down.push(frame),
              close: () => undefined,
              rpc: () => Promise.reject(new Error("no rpc here")),
              sendBlob: () => "",
              takeBlob: () => Promise.reject(new Error("no blobs here")),
            };
          },
          upgrade: async () => { agent.options.version = appVersion; },
        },
        version: () => appVersion,
        events: { item: () => undefined, exit: () => undefined },
      });
      session.begin({ config: CONFIG, words: "Do the task.", uuid: "00000000-0000-4000-8000-000000000000" });

      /** k -> the agent's name for request k (and back). */
      const keyOf = new Map<number, string>();
      const machine = () => machines.find(NAME);
      // The model keeps the path last asked for after a decline or an expiry (trust "none"); the app forgets the
      // machine altogether, so the path shown for no machine is the one last paired over.
      let lastVia: Path | "none" = "none";
      const keep = (n: number) => { const conn = conns.get(session.gen); if (conn) conn.down.splice(n); };
      const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

      return {
        async pair(path: Path) { lastVia = path; machines.add({ name: NAME, via: path, ...(path === "ssh" ? { host: NAME } : {}) }); },
        async approve() { machines.approve(machine()!.id); },
        async decline() { machines.decline(machine()!.id); },
        async expire() { machines.decline(machine()!.id); },
        async revoke(n: number) {
          if (session.conn !== "down") keep(n);
          machines.revoke(machine()!.id);
          session.revoked();
        },
        async appUpdate() { appVersion = "2"; },
        async connect() { session.connect(); },
        async upgrade() { await session.upgrade(); },
        async start() { session.start(); },
        async cancel() { session.cancel(); },
        async answer(k: number) {
          const key = keyOf.get(k);
          const card = key ? session.cards.get(key) : undefined;
          if (!key || !card) throw new Error(`no card for request ${k}`);
          session.answer(key, true, card.item.input);
          await settle();
        },
        async drop(n: number) {
          const conn = conns.get(session.gen)!;
          keep(n);
          conn.handlers.closed();
        },
        async appRecv(g: number) {
          const frame = conns.get(g)!.up.shift()!;
          session.recv(g, frame);
          await settle();
        },
        async agentRecv(g: number) {
          const conn = conns.get(g)!;
          const frame = conn.down.shift()!;
          await conn.agent.recv(frame as unknown as Record<string, unknown> & { t: string });
        },
        async notice() {
          const g = agent.connection(SESSION);
          const conn = conns.get(g);
          if (conn) await conn.agent.closed();
        },
        async out(run: number) { claudes.get(run)!.handlers.onItem({ kind: "assistantText", text: `out from run ${run}` }); },
        async ask(run: number, k: number) {
          const claude = claudes.get(run)!;
          const before = agent.logOf(SESSION).length;
          claude.handlers.onItem({ kind: "permission", requestId: `native-${run}-${k}`, tool: "Bash", summary: `request ${k}`, input: { k } } as never);
          const entry = agent.logOf(SESSION)[before];
          if (entry?.t !== "ask") throw new Error(`the agent did not log request ${k}`);
          const known = keyOf.get(k);
          if (known && known !== entry.k) throw new Error(`request ${k} asked again was named ${entry.k}, not ${known}`);
          keyOf.set(k, entry.k);
        },
        async finish(run: number) {
          const claude = claudes.get(run)!;
          claudes.delete(run);
          claude.handlers.onExit({ code: 0, signal: null, stderr: "", expected: false, silent: false });
        },
        view(): View {
          const m = machine();
          const card: CardState[] = [], noted: boolean[] = [];
          for (let k = 1; k <= options.maxReqs; k++) {
            const c = keyOf.has(k) ? session.cards.get(keyOf.get(k)!) : undefined;
            card.push(c?.state ?? "none");
            noted.push(!!c && c.noted && c.state === "open");
          }
          return { via: m?.via ?? lastVia, trust: m?.trust ?? "none", conn: session.conn, w: session.w, got: session.got, card, noted };
        },
        alive: () => agent.alive(SESSION),
        async close() {
          session.close();
          await agent.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  };
}
