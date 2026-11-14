// M1 demo bug 2: `botlingd backup`, `botlingd restore` and the daily backup failed under Electron as Node (how the
// Botling 3 window starts botlingd): Electron's Node refuses node:sqlite's backup `rate: -1` ("must be a positive
// integer") where plain Node takes it. Each one runs here under both runtimes, with the repo's Electron binary and
// ELECTRON_RUN_AS_NODE=1 for the second, on the built botlingd (out/server/main.cjs).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { StreamId } from "../../src/protocol";
import { appendEntries, ensureStream } from "../../src/server/log";
import { openReaderDb, openServerStore } from "../../src/server/store";
import { botlingdEnv, botlingdScript, testRoot } from "../botlingd-harness";
import { until } from "../helpers";

const electron = createRequire(import.meta.url)("electron") as unknown as string;
const runtimes = [
  { name: "node", bin: process.execPath, env: {} as Record<string, string> },
  { name: "electron", bin: electron, env: { ELECTRON_RUN_AS_NODE: "1" } as Record<string, string> },
] as const;

const root = testRoot("backup-runtimes");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BOT = "bot:b1" as StreamId;
async function dataDirWith(name: string, lines: number): Promise<string> {
  const dataDir = join(root, name);
  const store = await openServerStore(dataDir);
  await store.submit((db) => {
    ensureStream(db, BOT);
    appendEntries(db, BOT, Array.from({ length: lines }, (_, i) => ({ kind: "message.added", body: { botId: "b1", message: { id: `m${i}`, role: "user", text: `line ${i}`, time: new Date(0).toISOString() } } })));
  });
  await store.close();
  return dataDir;
}
const entries = (file: string) => { const db = openReaderDb(file); try { return Number(db.prepare("SELECT count(*) AS n FROM entries").get()?.n); } finally { db.close(); } };

describe.each(runtimes)("botlingd under $name", ({ name, bin, env }) => {
  const run = (dataDir: string, args: string[]) => spawnSync(bin, ["--no-warnings", botlingdScript, ...args], { env: { ...botlingdEnv(dataDir), ...env }, encoding: "utf8", timeout: 90_000 });

  it("runs as that runtime", () => {
    const probe = spawnSync(bin, ["-p", "process.versions.electron ?? 'none'"], { env: { ...botlingdEnv(root), ...env }, encoding: "utf8" });
    expect(probe.status).toBe(0);
    if (name === "electron") expect(probe.stdout.trim()).not.toBe("none");
    else expect(probe.stdout.trim()).toBe("none");
  });

  it("backup copies server.db, and restore puts it back", async () => {
    const dataDir = await dataDirWith(`cli-${name}`, 3);
    const backup = run(dataDir, ["backup"]);
    expect({ code: backup.status, stderr: backup.stderr }).toEqual({ code: 0, stderr: "" });
    const file = backup.stdout.trim();
    expect(file).toMatch(/server-manual-.*\.db$/);
    expect(entries(file)).toBe(3);
    const restore = run(dataDir, ["restore", file]);
    expect({ code: restore.status, stderr: restore.stderr }).toEqual({ code: 0, stderr: "" });
    expect(restore.stdout).toContain("restored ");
    expect(entries(join(dataDir, "server.db"))).toBe(3);
  });

  it("takes the daily backup while it runs", { timeout: 60_000 }, async () => {
    const dataDir = await dataDirWith(`daily-${name}`, 2);
    const child = spawn(bin, ["--no-warnings", botlingdScript, "start"], { env: { ...botlingdEnv(dataDir, { BOTLING_SERVER_BACKUP_CHECK_MS: "200" }), ...env }, stdio: "ignore" });
    const closed = new Promise((resolve) => child.once("close", resolve));
    const backups = join(dataDir, "backups");
    const daily = () => existsSync(backups) && readdirSync(backups).some((file) => file.startsWith("server-daily-"));
    try {
      await until(daily, { timeout: 30_000, what: "a daily backup" }).catch((error: Error) => {
        const log = existsSync(join(dataDir, "botlingd.log")) ? readFileSync(join(dataDir, "botlingd.log"), "utf8").slice(-2_000) : "(no log)";
        throw new Error(`${error.message}\nbotlingd.log: ${log}`);
      });
    } finally {
      child.kill("SIGTERM");
      await closed;
    }
    expect(daily()).toBe(true);
  });
});
