// botlingd's command line (M1 step 9), built to out/server/main.cjs. Runs under plain Node and under Electron as Node
// (ELECTRON_RUN_AS_NODE=1, how the Botling 3 window starts it). The data folder is BOTLING_SERVER_DATA_DIR, else
// BOTLING_DATA_DIR (session/paths.ts).
//
//   botlingd start            serve in the foreground until SIGTERM / SIGINT (prints "ready <socket>" once listening);
//                             exits 75 when another server or core holds the data folder; never imports 1.x/2.x data
//                             from an inherited BOTLING_IMPORT_FROM / BOTLING_1X_DIR (inherited-env.ts)
//   botlingd stop             asks the running server to stop (SIGTERM to the lock holder) and waits for it
//   botlingd service install | uninstall | status
//                             (M6-08) manages the login item (LaunchAgent on macOS, systemd user unit on Linux)
//   botlingd status [--json]  running or not, its pid and socket, the turns under way (from server.db), the Doctor notes
//                             (external disk, backups missing or old, a restore), the newest backup, the loopback
//                             listener (127.0.0.1:BOTLING_SERVER_PORT, default 8744, "off" for none) and the
//                             `tailscale serve` command that publishes it (printed only, never run)
//   botlingd backup           an online backup of server.db into <data>/backups/ (the server may keep running); while
//                             it runs, botlingd also takes a daily one (keeps 7)
//   botlingd restore <file> [--stop]
//                             puts a backup back with the server stopped (restore.ts says why); refused (exit 75) while
//                             it runs, unless --stop, which stops it first. It is not started again here: a Botling 3
//                             window starts it when it reconnects, or run botlingd start.
//   botlingd import <2.x folder> [--dry-run]
//                             (M6-01d) imports a Botling 2.x data folder into this folder (read-only on 2.x)
//                             and writes <data>/import-report.md; --dry-run previews the report without writing
//   botlingd pair [--name <device name>] [--scope read,reply,approve,manage] [--no-qr]
//                             pairs a phone or browser with the running server (M2 step 5): the first pairing shows the
//                             recovery code once and makes the cluster only after it is typed back; then a link and QR
//                             code (5 min, single use), the 6-digit code to compare, and the device's ack
//   botlingd join [--name <name>]
//                             (M3 step 4) offers this server to join a cluster: prints its fingerprint, a code and a link
//   botlingd add-machine [<link>] [--expect-fingerprint <fp>]
//                             (M3 step 4) pairs the server whose `join` printed that link into this server's cluster;
//                             with no argument it reads the link from stdin (keeps its secret out of the process list);
//                             asks "yes" that N shows the fingerprint it prints, or checks --expect-fingerprint
//   botlingd machines [--json]
//                             (M3 step 13) this server's fingerprint and every other server of its cluster: name,
//                             fingerprint, state (live / stale / gone) and since, and how many commands wait for it;
//                             read from the data folder, so it answers whether or not botlingd runs
//   botlingd designate <machine>
//                             (M5-04i) sets the cluster's designatedServer preference to that machine (takes effect at
//                             each server's next start)
//   botlingd machines remove <name-or-id> [--yes | --only]
//                             (M4-05) on the revocation root: previews what it added, asks once, and revokes it
//   botlingd machines dropped [--json]
//                             (M4-10) lists dropped server revocations; on the root offers revoke again or dismiss
//   botlingd recovery replace (M4-12) on the revocation root: verifies the old recovery code and replaces it
//   botlingd reroot [--keep-all] [--old-root lost|keep]
//                             (M4-11) makes this server the revocation root; recovery code is read from stdin only
//   botlingd relay [set <url> | clear]
//                             the relay this server keeps its room on (the Botling 3 phone page and its pairing link
//                             are then on that relay when no tailnet origin is set): shows it, keeps one (wss://…/ws)
//                             in <data>/relay.json, or removes it; takes effect when botlingd next starts.
//                             BOTLING_SERVER_RELAY_URL, when set, wins
//   botlingd devices [--json] the paired devices (valid and revoked)
//   botlingd revoke-device <id> [--reason <text>]
//                             revokes a device: its sessions end at once and it can never connect again
//   botlingd plugins          (M5-14c) every plugin on this machine: name, what it is allowed (a tier word) and the first
//                             8 characters of its code hash
//   botlingd plugins grant <name> --tier read|request|write
//                             allows the plugin that tier for its current code, with what it asks for (a local-window
//                             `plugin.grant`; a built-in's grant is fixed, and a tier above its asks is refused)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_EXIT_DATA_DIR_IN_USE, DataDirLock, readLockHolder } from "../core/store/data-dir-lock";
import { Botlingd, BOTLINGD_VERSION, DataDirInUseError, pairingPageUrl, PLACEHOLDER_TAILNET_ORIGIN, tailnetOrigin } from "./botlingd";
import { LISTEN_FILE, LISTEN_HOST, listenPort, readRelaySetting, RELAY_URL_ENV, RelaySettingError, tailscaleServeCommand, writeRelaySetting } from "./net";
import { newestAnyBackup, serverNotes, type ServerNote } from "./notes";
import { machinesLines, peerNotes, readForwardQueue, readMachines, type ForwardQueueReport, type MachinesReport } from "./machines";
import { dropInheritedImport } from "./inherited-env";
import { ImportError, runImport } from "./import/run";
import { RestoreError, restoreBackup } from "./restore";
import { serviceCommand, ServiceError } from "./service";
import { pluginsCommand } from "./plugin-cli";
import { AdminClient, addMachineCommand, createStdinIo, devicesCommand, droppedMachinesCommand, joinCommand, pairCommand, parseRerootArgs, recoveryReplaceCommand, removeMachineCommand, RerootArgsError, rerootCommand, revokeDeviceCommand, type CliIo, type RerootOptions } from "./pairing";
import { fetchCommand } from "./fetch/cli";
import { botlingdPaths, PathsError, readToken, refuse2xData, socketAnswers, type BotlingdPaths } from "./session";
import { DeviceScope } from "../protocol";
import { takeBackup } from "./store";
import { openReaderDb } from "./store/connection";
import type { ElectronUtilityContext } from "./packaged-electron";
import { machineLabel } from "./designated";

const out = (line: string) => process.stdout.write(`${line}\n`);
const fail = (line: string, code = 1): never => { process.stderr.write(`botlingd: ${line}\n`); process.exit(code); };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The pid of the process holding the data folder now, or null. */
function holderPid(dataDir: string): number | null {
  const holder = readLockHolder(dataDir);
  return holder && alive(holder.pid) ? holder.pid : null;
}

export interface ServerCliOptions { packaged?: boolean; appId?: string; outDir?: string; execPath?: string; electronUtility?: ElectronUtilityContext }

async function start(options: ServerCliOptions = {}): Promise<void> {
  // Importing 1.x/2.x data is M6's explicit step: an inherited BOTLING_IMPORT_FROM / BOTLING_1X_DIR is not acted on.
  const ignored = dropInheritedImport(process.env);
  if (ignored.length) process.stderr.write(`botlingd: ignoring ${ignored.join(" and ")} from the environment (Botling 3 does not import 1.x/2.x data yet)\n`);
  let daemon: Botlingd;
  try {
    daemon = await Botlingd.start({
      env: process.env,
      outDir: options.outDir ?? join(__dirname, ".."),
      ...(options.packaged ? { packaged: true } : {}),
      ...(options.electronUtility ? { electronUtility: options.electronUtility } : {}),
    });
  } catch (error) {
    if (error instanceof DataDirInUseError) fail(error.message, process.env.BOTLING_SERVICE === "1" ? 0 : CORE_EXIT_DATA_DIR_IN_USE);
    if (error instanceof PathsError) fail(error.message, 2);
    fail(`did not start: ${(error as Error)?.stack ?? String(error)}`);
    return;
  }
  out(`ready ${daemon.paths.socket}`);
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    daemon.stop().then(() => process.exit(code), (error) => {
      process.stderr.write(`botlingd: stop failed: ${(error as Error)?.message ?? String(error)}\n`);
      process.exit(1);
    });
  };
  process.on("SIGTERM", () => stop(0));
  process.on("SIGINT", () => stop(0));
  process.on("SIGHUP", () => stop(0));
  process.on("uncaughtException", (error) => {
    process.stderr.write(`botlingd: uncaught: ${error?.stack ?? String(error)}\n`);
    stop(1);
  });
}

async function stopCommand(dataDir: string): Promise<void> {
  const pid = holderPid(dataDir);
  if (pid === null) { out("botlingd is not running."); return; }
  process.kill(pid, "SIGTERM");
  // Stopped = it let go of the data folder (its last step) or is gone. A process that exited but was not reaped yet by
  // its parent still answers kill(pid, 0), so the lock is what counts.
  const holds = () => alive(pid) && readLockHolder(dataDir)?.pid === pid;
  const until = Date.now() + 60_000;
  while (holds() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  if (holds()) fail(`pid ${pid} did not stop within 60 s`);
  out(`botlingd (pid ${pid}) stopped.`);
}

interface Status {
  version: string;
  dataDir: string;
  running: boolean;
  pid: number | null;
  socket: string;
  answers: boolean;
  bots: number;
  turns: Array<{ botId: string; turnId: string; state: string; startedAt: number | null; liveChars: number }>;
  /** The newest backup (any kind) and when it was taken, or null. */
  backup: { path: string; at: number } | null;
  notes: ServerNote[];
  /** The other servers of the cluster and their states (M3 step 13; empty for a lone server). */
  machines: MachinesReport;
  /** Commands held here for another server's targets (M3 step 13). */
  forwardQueue: ForwardQueueReport;
  /** The running server's cluster (null before the first pairing), when it answers. */
  clusterId?: string | null;
  /** While a recovery code was shown and not typed back yet (the cluster is not made until it is). */
  recoveryNote?: string | null;
  /** The loopback listener: running (port), configured (not running), its error, or off (null). */
  listener: { address: string; port: number; listening: boolean; error?: string } | null;
  /** The command that publishes the listener on the tailnet, and the page address it gives (a placeholder name until set). */
  tailscaleServe: { command: string; page: string; placeholder: boolean } | null;
}

/** The listener as the running server wrote it, else as configured; and the `tailscale serve` line for its port. */
function listenerStatus(dataDir: string, pid: number | null): Pick<Status, "listener" | "tailscaleServe"> {
  let listener: Status["listener"] = null;
  if (pid !== null) {
    try {
      const state = JSON.parse(readFileSync(join(dataDir, LISTEN_FILE), "utf8")) as { pid?: number; port?: number; error?: string };
      if (state.pid === pid && typeof state.port === "number") {
        listener = { address: LISTEN_HOST, port: state.port, listening: !state.error, ...(state.error ? { error: state.error } : {}) };
      }
    } catch { /* off, or an older server */ }
  }
  if (!listener) {
    let port: number | null = null;
    try { port = listenPort(process.env); } catch (error) { return { listener: { address: LISTEN_HOST, port: 0, listening: false, error: (error as Error).message }, tailscaleServe: null }; }
    if (port === null) return { listener: null, tailscaleServe: null };
    listener = { address: LISTEN_HOST, port, listening: false };
  }
  if (!listener.port) return { listener, tailscaleServe: null };
  const origin = tailnetOrigin(process.env);
  return { listener, tailscaleServe: { command: tailscaleServeCommand(listener.port), page: `${origin ?? PLACEHOLDER_TAILNET_ORIGIN}/v3/`, placeholder: !origin } };
}

async function status(dataDir: string, socket: string): Promise<Status> {
  const pid = holderPid(dataDir);
  const answers = existsSync(socket) ? await socketAnswers(socket) : false;
  const result: Status = {
    version: BOTLINGD_VERSION, dataDir, running: pid !== null, pid, socket, answers, bots: 0, turns: [],
    backup: newestAnyBackup(join(dataDir, "backups")), notes: [], ...listenerStatus(dataDir, pid),
    machines: { self: null, peers: [] }, forwardQueue: { rows: 0, cancels: 0, oldestHeldAt: null, owners: [] },
  };
  const file = join(dataDir, "server.db");
  if (!existsSync(file)) { result.notes = serverNotes(dataDir, null); result.machines = readMachines(dataDir, null, pid); return result; }
  const db = openReaderDb(file);
  try {
    result.bots = Number(db.prepare("SELECT count(*) AS n FROM bots").get()?.n ?? 0);
    const live = new Map(db.prepare("SELECT botId, liveTurnId, liveText FROM bots WHERE liveTurnId IS NOT NULL").all()
      .map((row) => [`${row.botId}\u0000${row.liveTurnId}`, String(row.liveText ?? "").length]));
    result.turns = db.prepare("SELECT botId, turnId, state, startedAt FROM effects WHERE kind = 'turn' AND state IN ('queued', 'started') ORDER BY startedAt").all()
      .map((row) => ({
        botId: String(row.botId ?? ""), turnId: String(row.turnId ?? ""), state: String(row.state),
        startedAt: row.startedAt == null ? null : Number(row.startedAt), liveChars: live.get(`${row.botId}\u0000${row.turnId}`) ?? 0,
      }));
    result.machines = readMachines(dataDir, db, pid);
    result.forwardQueue = readForwardQueue(db);
    result.notes = [...serverNotes(dataDir, db), ...peerNotes(result.machines, result.forwardQueue)];
  } finally {
    db.close();
  }
  // The pending cluster setup lives only in the running server's memory (the code is never written anywhere): ask it.
  const token = answers ? readToken(join(dataDir, "botlingd.token")) : null;
  if (answers && token) {
    try {
      const client = await AdminClient.connect(socket, token, 3_000);
      try {
        const cluster = await client.request({ op: "cluster.status" }, 3_000) as { clusterId: string | null; note: string | null };
        result.clusterId = cluster.clusterId;
        result.recoveryNote = cluster.note;
      } finally {
        client.close();
      }
    } catch { /* an older server or a busy one: the rest of the status stands */ }
  }
  return result;
}

/** Line input for the CLI's questions (null once stdin ended; suppresses TTY echo for secret prompts). */
function stdinIo(): CliIo & { close(): void } {
  return createStdinIo(process.stdin, process.stdout);
}

/** A local admin session with the running server, or exit with why not. */
async function adminSession(paths: BotlingdPaths): Promise<AdminClient> {
  if (holderPid(paths.dataDir) === null || !existsSync(paths.socket)) fail("botlingd is not running (botlingd start).", 3);
  const token = readToken(paths.token);
  if (!token) fail(`no local token at ${paths.token}; is botlingd running?`, 3);
  try {
    return await AdminClient.connect(paths.socket, token!);
  } catch (error) {
    return fail(`cannot reach botlingd: ${(error as Error).message}`, 3);
  }
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

export async function main(argv: string[], options: ServerCliOptions = {}): Promise<void> {
  const [command = "start", ...rest] = argv;
  let paths!: BotlingdPaths;
  if (command !== "service") {
    try { paths = botlingdPaths(process.env); } catch (error) { fail((error as Error).message, 2); return; }
  }
  switch (command) {
    case "start": await start(options); return;
    case "stop": await stopCommand(paths.dataDir); return;
    case "status": {
      const report = await status(paths.dataDir, paths.socket);
      if (rest.includes("--json")) { out(JSON.stringify(report)); return; }
      out(report.running ? `botlingd is running (pid ${report.pid})${report.answers ? ` on ${report.socket}` : ", its socket does not answer"}.` : "botlingd is not running.");
      out(`data: ${report.dataDir} · ${report.bots} bots`);
      if (!report.turns.length) out("no turns under way");
      for (const turn of report.turns) {
        const since = turn.startedAt ? ` since ${new Date(turn.startedAt).toISOString()}` : "";
        out(`turn ${turn.turnId} of ${turn.botId}: ${turn.state}${since}${turn.liveChars ? `, ${turn.liveChars} characters so far` : ""}`);
      }
      if (report.machines.peers.length || report.forwardQueue.rows) {
        for (const line of machinesLines(report.machines, report.forwardQueue).filter((line) => !line.startsWith("this machine"))) out(`machine ${line}`);
        const queue = report.forwardQueue;
        out(queue.rows
          ? `forward queue: ${queue.rows} command${queue.rows === 1 ? "" : "s"} held for other machines (oldest since ${new Date(queue.oldestHeldAt!).toISOString().replace(/\.\d+Z$/, "Z")})${queue.cancels ? `, ${queue.cancels} cancel${queue.cancels === 1 ? "" : "s"}` : ""}`
          : "forward queue: empty");
      }
      out(report.backup ? `newest backup: ${report.backup.path} (${new Date(report.backup.at).toISOString()})` : "no backup yet");
      for (const note of report.notes) out(`note: ${note.text}`);
      if (report.recoveryNote) out(`note: ${report.recoveryNote}`);
      if (report.answers && report.clusterId !== undefined) out(report.clusterId ? `cluster: ${report.clusterId}` : "cluster: none yet (made at the first pairing: botlingd pair)");
      const listener = report.listener;
      if (!listener) out("listener: off (BOTLING_SERVER_PORT=off)");
      else if (listener.listening) out(`listener: http://${listener.address}:${listener.port} (loopback only)`);
      else if (listener.error) out(`listener: not listening on ${listener.address}:${listener.port || "?"}: ${listener.error}`);
      else out(`listener: ${listener.address}:${listener.port || "a free port"} once botlingd runs (loopback only)`);
      if (report.tailscaleServe) {
        out(`tailscale serve (run it yourself; botlingd never does): ${report.tailscaleServe.command}`);
        out(report.tailscaleServe.placeholder
          ? `  devices then open ${report.tailscaleServe.page}: replace tailnet-name.invalid with this machine's tailnet name and set BOTLING_SERVER_TAILNET_ORIGIN to that https origin`
          : `  devices then open ${report.tailscaleServe.page}`);
      }
      return;
    }
    case "pair": {
      const scopeText = flag(rest, "--scope");
      let scope: DeviceScope[] | undefined;
      if (scopeText !== undefined) {
        const parsed = scopeText.split(/[,+]/).map((item) => DeviceScope.safeParse(item.trim()));
        if (!parsed.length || parsed.some((item) => !item.success)) fail("--scope takes read, reply, approve, manage (comma-separated)", 2);
        scope = parsed.map((item) => item.data!);
      }
      const client = await adminSession(paths);
      const io = stdinIo();
      const name = flag(rest, "--name");
      let code = 1;
      try {
        code = await pairCommand(client, io, { ...(name ? { name } : {}), ...(scope ? { scope } : {}), qr: !rest.includes("--no-qr") });
      } finally {
        io.close();
        client.close();
      }
      process.exit(code);
      return;
    }
    case "join": {
      const client = await adminSession(paths);
      const io = stdinIo();
      const name = flag(rest, "--name");
      let code = 1;
      try { code = await joinCommand(client, io, name ? { name } : {}); } finally { io.close(); client.close(); }
      process.exit(code);
      return;
    }
    case "add-machine": {
      // With no argument the link is read from stdin (its secret then stays out of the process list).
      const expectFingerprint = flag(rest, "--expect-fingerprint");
      if (rest.includes("--expect-fingerprint") && expectFingerprint === undefined) fail("--expect-fingerprint needs the fingerprint botlingd join printed on the other machine", 2);
      const link = rest.find((arg, at) => !arg.startsWith("--") && rest[at - 1] !== "--expect-fingerprint");
      const client = await adminSession(paths);
      const io = stdinIo();
      let code = 1;
      try { code = await addMachineCommand(client, io, link, expectFingerprint !== undefined ? { expectFingerprint } : {}); } finally { io.close(); client.close(); }
      process.exit(code);
      return;
    }
    case "machines": {
      if (rest[0] === "remove") {
        const removeArgs = rest.slice(1);
        const unknown = removeArgs.find((arg) => arg.startsWith("--") && arg !== "--yes" && arg !== "--only");
        if (unknown) fail(`unknown option "${unknown}" (use --yes or --only)`, 2);
        const yes = removeArgs.includes("--yes");
        const only = removeArgs.includes("--only");
        if (yes && only) fail("machines remove takes either --yes or --only, not both", 2);
        const target = removeArgs.find((arg) => !arg.startsWith("--"));
        if (!target) fail("machines remove needs a machine name or id: botlingd machines remove <name-or-id> [--yes | --only] (botlingd machines lists them)", 2);
        const client = await adminSession(paths);
        const io = stdinIo();
        let code = 1;
        try {
          code = await removeMachineCommand(client, io, target!, { ...(yes ? { yes: true } : {}), ...(only ? { only: true } : {}) });
        } finally {
          io.close();
          client.close();
        }
        process.exit(code);
        return;
      }
      if (rest[0] === "dropped") {
        const droppedArgs = rest.slice(1);
        const unknown = droppedArgs.find((arg) => arg !== "--json");
        if (unknown) fail(`unknown option "${unknown}" (use --json)`, 2);
        const client = await adminSession(paths);
        const io = stdinIo();
        let code = 1;
        try {
          code = await droppedMachinesCommand(client, io, { json: droppedArgs.includes("--json") });
        } finally {
          io.close();
          client.close();
        }
        process.exit(code);
        return;
      }
      const file = join(paths.dataDir, "server.db");
      const pid = holderPid(paths.dataDir);
      const db = existsSync(file) ? openReaderDb(file) : null;
      try {
        const machines = readMachines(paths.dataDir, db, pid);
        const queue = db ? readForwardQueue(db) : null;
        if (rest.includes("--json")) { out(JSON.stringify({ running: pid !== null, ...machines, forwardQueue: queue })); return; }
        if (pid === null) out("botlingd is not running: states are as last stored (nothing is live).");
        for (const line of machinesLines(machines, queue)) out(line);
      } finally {
        db?.close();
      }
      return;
    }
    case "designate": {
      const unknown = rest.find((arg) => arg.startsWith("--"));
      if (unknown) fail(`unknown option "${unknown}"`, 2);
      const target = rest.find((arg) => !arg.startsWith("--"))?.trim();
      if (!target) return fail("designate needs a machine name or id: botlingd designate <machine> (botlingd machines lists them)", 2);
      const file = join(paths.dataDir, "server.db");
      const pid = holderPid(paths.dataDir);
      const db = existsSync(file) ? openReaderDb(file) : null;
      let machines: MachinesReport;
      try {
        machines = readMachines(paths.dataDir, db, pid);
      } finally {
        db?.close();
      }
      const candidates: Array<{ member: string; name: string | null; fingerprint: string }> = [
        ...(machines.self ? [machines.self] : []),
        ...machines.peers,
      ];
      let resolved: { member: string; name: string | null; fingerprint: string } | null = null;
      const byId = candidates.find((item) => item.member === target);
      if (byId) {
        resolved = byId;
      } else {
        const byName = candidates.filter((item) => item.name === target);
        if (byName.length > 1) {
          const choices = byName.map((item) => `${item.member} (${item.fingerprint})`).join(", ");
          fail(`more than one machine is named "${machineLabel(target)}" (${choices}); pass the id instead`, 2);
        }
        if (byName.length === 1) {
          resolved = byName[0]!;
        } else {
          const fpKey = target.replace(/[\s-]/g, "").toLowerCase();
          if (/^[a-z2-7]{26}$/.test(fpKey)) {
            resolved = candidates.find((item) => item.member === fpKey) ?? null;
          }
        }
      }
      if (!resolved) return fail(`no machine named "${machineLabel(target)}" (botlingd machines lists them)`, 2);
      const client = await adminSession(paths);
      try {
        await client.request({ op: "prefs.set", key: "designatedServer", value: resolved.member });
      } catch (error) {
        fail(`cannot designate ${machineLabel(resolved.name ?? target)}: ${(error as Error).message}`, 2);
      } finally {
        client.close();
      }
      out(`designated ${machineLabel(resolved.name ?? target)}; its main bot takes over when each server next starts.`);
      return;
    }
    case "recovery": {
      if (rest[0] !== "replace") fail(`unknown recovery command "${rest[0] ?? ""}" (use: botlingd recovery replace)`, 2);
      if (rest.length > 1) fail("recovery replace takes no arguments (recovery codes are read from stdin)", 2);
      const client = await adminSession(paths);
      const io = stdinIo();
      let code = 1;
      try {
        code = await recoveryReplaceCommand(client, io);
      } finally {
        io.close();
        client.close();
      }
      process.exit(code);
      return;
    }
    case "reroot": {
      let options: RerootOptions;
      try {
        options = parseRerootArgs(rest);
      } catch (error) {
        if (error instanceof RerootArgsError) fail(error.message, 2);
        throw error;
      }
      const client = await adminSession(paths);
      const io = stdinIo();
      let code = 1;
      try {
        code = await rerootCommand(client, io, options);
      } finally {
        io.close();
        client.close();
      }
      process.exit(code);
      return;
    }
    case "relay": {
      const [action, value, ...extra] = rest;
      if (extra.length || (action === "set" && !value) || (action === "clear" && value) || (action !== undefined && action !== "set" && action !== "clear")) {
        return fail("use: botlingd relay | botlingd relay set <wss://…/ws> | botlingd relay clear", 2);
      }
      if (action === "set" || action === "clear") {
        try {
          refuse2xData(paths.dataDir); // never a file in a 2.x data folder
          writeRelaySetting(paths.dataDir, action === "set" ? value! : null);
        } catch (error) {
          if (error instanceof RelaySettingError || error instanceof PathsError) return fail(error.message, 2);
          throw error;
        }
      }
      let kept: string | null = null;
      try { kept = readRelaySetting(paths.dataDir); } catch (error) { out(`note: ${(error as Error).message}`); }
      out(kept ? `relay: ${kept}` : "relay: off");
      if (kept) out(`  phones open ${pairingPageUrl(tailnetOrigin(process.env), kept)} to pair (when no tailnet origin is set)`);
      if ((process.env[RELAY_URL_ENV] ?? "").trim() !== "") out(`note: ${RELAY_URL_ENV} is set, so botlingd uses it instead of this setting`);
      if (action) out(holderPid(paths.dataDir) === null ? "botlingd uses it at its next start." : "botlingd is running: it uses this at its next start (quit and reopen Botling 3).");
      return;
    }
    case "devices": {
      const client = await adminSession(paths);
      try { process.exitCode = await devicesCommand(client, { out, ask: async () => null }, { json: rest.includes("--json") }); } finally { client.close(); }
      return;
    }
    case "revoke-device": {
      const id = rest.find((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--reason");
      if (!id) fail("revoke-device needs the device id: botlingd revoke-device <id> [--reason <text>] (botlingd devices lists them)", 2);
      const client = await adminSession(paths);
      try { process.exitCode = await revokeDeviceCommand(client, { out, ask: async () => null }, id!, flag(rest, "--reason")); } finally { client.close(); }
      return;
    }
    case "fetch": {
      const client = await adminSession(paths);
      try { process.exitCode = await fetchCommand(client, { out, err: (line) => process.stderr.write(`${line}\n`) }, rest); } finally { client.close(); }
      return;
    }
    case "plugins": {
      // `plugins` lists, `plugins grant <name> --tier read|request|write` grants (M5-14c), over the local admin socket.
      const client = await adminSession(paths);
      try { process.exitCode = await pluginsCommand(client, { out, ask: async () => null }, rest); } finally { client.close(); }
      return;
    }
    case "service": {
      try {
        await serviceCommand(rest, process.env, out, { packaged: options.packaged, appId: options.appId, execPath: options.execPath });
      } catch (error) {
        if (error instanceof PathsError) fail(error.message, 2);
        if (error instanceof ServiceError) fail(error.message, error.exitCode);
        throw error;
      }
      return;
    }
    case "backup": {
      const file = join(paths.dataDir, "server.db");
      if (!existsSync(file)) fail(`no server.db in ${paths.dataDir}`);
      out(await takeBackup(file, join(paths.dataDir, "backups"), "manual"));
      return;
    }
    case "restore": {
      const stopFirst = rest.includes("--stop");
      const backup = rest.find((arg) => !arg.startsWith("--"));
      if (!backup) fail("restore needs the backup file: botlingd restore <file> [--stop]", 2);
      if (stopFirst) await stopCommand(paths.dataDir);
      const lock = new DataDirLock(paths.dataDir, { version: BOTLINGD_VERSION, app: "botlingd restore" });
      const claim = lock.claim();
      if (!claim.ok) fail(`botlingd (pid ${claim.holder.pid}) is running; stop it first (botlingd stop, or botlingd restore <file> --stop).`, CORE_EXIT_DATA_DIR_IN_USE);
      try {
        const result = await restoreBackup(paths.dataDir, backup!);
        const taken = `${new Date(result.restoredTo).toISOString()}${result.restoredToFrom === "metadata" ? "" : `, from its ${result.restoredToFrom}`}`;
        out(`restored ${result.restoredFrom} (taken ${taken}); ${result.streams} streams got a new logId${result.keptAs ? `; the replaced file is kept as ${result.keptAs}` : ""}.`);
        out("Start botlingd again (botlingd start; a Botling 3 window starts it by itself).");
      } catch (error) {
        if (error instanceof RestoreError) { lock.release(); fail(error.message, 2); }
        throw error;
      } finally {
        lock.release();
      }
      return;
    }
    case "import": {
      const unknown = rest.find((arg) => arg.startsWith("-") && arg !== "--dry-run");
      if (unknown) fail(`unknown option "${unknown}" (use: botlingd import <2.x folder> [--dry-run])`, 2);
      const positional = rest.filter((arg) => !arg.startsWith("-"));
      if (positional.length !== 1) fail("import needs one 2.x data folder: botlingd import <2.x folder> [--dry-run]", 2);
      const dryRun = rest.includes("--dry-run");
      try {
        const result = await runImport({ sourceDir: positional[0]!, targetDir: paths.dataDir, dryRun });
        process.stdout.write(result.reportText);
      } catch (error) {
        if (error instanceof ImportError) fail(error.message, error.exitCode);
        if (error instanceof PathsError) fail(error.message, 2);
        throw error;
      }
      return;
    }
    default:
      fail(`unknown command "${command}" (start, stop, status, service, backup, restore, import, relay, pair, join, add-machine, machines, designate, recovery, reroot, devices, revoke-device, fetch, plugins)`, 2);
  }
}

if (!(globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ && !(globalThis as { __botlingdManualMain?: boolean }).__botlingdManualMain) {
  main(process.argv.slice(2)).catch((error) => fail((error as Error)?.stack ?? String(error)));
}
