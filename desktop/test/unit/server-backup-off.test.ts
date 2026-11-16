// Daily backups of server.db are OFF by default (the file was 8 GB; seven full copies filled the disk). On the built
// botlingd (out/server/main.cjs), on a temp data folder:
// - a start without BOTLING_SERVER_BACKUP_CHECK_MS takes no daily backup and logs that they are off;
// - a daily backup stamped in the future (the placeholder the manager laid down as a stopgap) is removed at start,
//   and a real daily, a manual and a pre-migration copy are left alone;
// - `botlingd status` raises no backup note with backups off, and `no-backup` with BOTLING_SERVER_DAILY_BACKUP=1;
// - a positive BOTLING_SERVER_BACKUP_CHECK_MS still takes one (the switch for tests).
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { botlingdCommand, BotlingdProcess, testRoot } from "../botlingd-harness";
import { until } from "../helpers";

const root = testRoot("backup-off");
const running: BotlingdProcess[] = [];
afterAll(async () => {
  for (const daemon of running) await daemon.stop("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

const dailyFiles = (dataDir: string) => (existsSync(join(dataDir, "backups")) ? readdirSync(join(dataDir, "backups")).filter((name) => name.startsWith("server-daily-")) : []);

async function runOnce(dataDir: string, extra: Record<string, string> = {}, waitMs = 0): Promise<BotlingdProcess> {
  const daemon = new BotlingdProcess(dataDir, { BOTLING_SERVER_PORT: "off", ...extra });
  running.push(daemon);
  await daemon.ready();
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  await daemon.stop();
  return daemon;
}

describe("daily backups are off by default", () => {
  it("takes none, says so, and removes a daily backup stamped in the future (keeps the other kinds)", async () => {
    const dataDir = join(root, "default");
    await runOnce(dataDir); // first start: creates server.db
    const backups = join(dataDir, "backups");
    mkdirSync(backups, { recursive: true });
    const seed = join(backups, "seed.db");
    copyFileSync(join(dataDir, "server.db"), seed);
    const placeholder = "server-daily-20991231T000000Z.db";
    const keep = ["server-daily-20200101T000000Z.db", "server-manual-20991231T000000Z.db", "server-pre-migration-20200101T000000Z.db"];
    for (const name of [placeholder, ...keep]) copyFileSync(seed, join(backups, name));
    rmSync(seed);

    const daemon = await runOnce(dataDir, {}, 1_500);
    expect(readdirSync(backups).sort()).toEqual(keep.sort());
    expect(daemon.log).toMatch(/daily backups are off/);
    expect(daemon.log).toContain(`removed a daily backup stamped in the future: ${join(backups, placeholder)}`);
    expect(daemon.log).not.toMatch(/note \((no-backup|old-backup)\)/);
  });

  it("status says nothing about backups when off; with BOTLING_SERVER_DAILY_BACKUP=1 and none taken it warns", () => {
    const dataDir = join(root, "default"); // has a pre-migration copy from 2020 and a manual one: "old" if backups were on
    const ids = (extra: Record<string, string>) => (JSON.parse(botlingdCommand(dataDir, ["status", "--json"], extra).stdout) as { notes: Array<{ id: string }> }).notes.map((note) => note.id);
    expect(ids({})).not.toContain("old-backup");
    expect(ids({})).not.toContain("no-backup");
    expect(ids({ BOTLING_SERVER_DAILY_BACKUP: "1" })).toContain("old-backup");
  });

  it("a positive BOTLING_SERVER_BACKUP_CHECK_MS takes one (the override for tests)", async () => {
    const dataDir = join(root, "on");
    await runOnce(dataDir, { BOTLING_SERVER_BACKUP_CHECK_MS: "200" }, 1_000);
    await until(() => dailyFiles(dataDir).length >= 1 || null, { timeout: 10_000, what: "a daily backup" });
  });
});
