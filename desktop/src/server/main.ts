// botlingd's command line (M1 step 9), built to out/server/main.cjs. Runs under plain Node and under Electron as Node
// (ELECTRON_RUN_AS_NODE=1, how the Botling 3 window starts it). The data folder is BOTLING_SERVER_DATA_DIR, else
// BOTLING_DATA_DIR (session/paths.ts).
//
//   botlingd start            serve in the foreground until SIGTERM / SIGINT (prints "ready <socket>" once listening);
//                             exits 75 when another server or core holds the data folder
//   botlingd stop             asks the running server to stop (SIGTERM to the lock holder) and waits for it
//   botlingd status [--json]  running or not, its pid and socket, the turns under way (from server.db)
//   botlingd backup           an online backup of server.db into <data>/backups/ (the server may keep running)
//   botlingd restore <file>   puts a backup back (the server must be stopped; minimal in M1, step 12 completes it)
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CORE_EXIT_DATA_DIR_IN_USE, DataDirLock, readLockHolder } from "../core/store/data-dir-lock";
import { Botlingd, BOTLINGD_VERSION, DataDirInUseError } from "./botlingd";
import { restoreBackup } from "./restore";
import { botlingdPaths, PathsError, socketAnswers } from "./session";
import { takeBackup } from "./store";
import { openReaderDb } from "./store/connection";

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

async function start(): Promise<void> {
  let daemon: Botlingd;
  try {
    daemon = await Botlingd.start({ env: process.env, outDir: join(__dirname, "..") });
  } catch (error) {
    if (error instanceof DataDirInUseError) fail(error.message, CORE_EXIT_DATA_DIR_IN_USE);
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
  const until = Date.now() + 60_000;
  while (alive(pid) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  if (alive(pid)) fail(`pid ${pid} did not stop within 60 s`);
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
}

async function status(dataDir: string, socket: string): Promise<Status> {
  const pid = holderPid(dataDir);
  const answers = existsSync(socket) ? await socketAnswers(socket) : false;
  const result: Status = { version: BOTLINGD_VERSION, dataDir, running: pid !== null, pid, socket, answers, bots: 0, turns: [] };
  const file = join(dataDir, "server.db");
  if (!existsSync(file)) return result;
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
  } finally {
    db.close();
  }
  return result;
}

async function main(argv: string[]): Promise<void> {
  const [command = "start", ...rest] = argv;
  let paths;
  try { paths = botlingdPaths(process.env); } catch (error) { fail((error as Error).message, 2); return; }
  switch (command) {
    case "start": await start(); return;
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
      return;
    }
    case "backup": {
      const file = join(paths.dataDir, "server.db");
      if (!existsSync(file)) fail(`no server.db in ${paths.dataDir}`);
      out(await takeBackup(file, join(paths.dataDir, "backups"), "manual"));
      return;
    }
    case "restore": {
      const backup = rest[0];
      if (!backup) fail("restore needs the backup file: botlingd restore <file>", 2);
      const lock = new DataDirLock(paths.dataDir, { version: BOTLINGD_VERSION, app: "botlingd restore" });
      const claim = lock.claim();
      if (!claim.ok) fail(`botlingd (pid ${claim.holder.pid}) is running; stop it first (botlingd stop).`, CORE_EXIT_DATA_DIR_IN_USE);
      try {
        const result = await restoreBackup(paths.dataDir, backup);
        out(`restored ${result.restoredFrom} (taken ${new Date(result.restoredTo).toISOString()}); ${result.streams} streams got a new logId${result.keptAs ? `; the replaced file is kept as ${result.keptAs}` : ""}.`);
      } finally {
        lock.release();
      }
      return;
    }
    default:
      fail(`unknown command "${command}" (start, stop, status, backup, restore)`, 2);
  }
}

main(process.argv.slice(2)).catch((error) => fail((error as Error)?.stack ?? String(error)));
