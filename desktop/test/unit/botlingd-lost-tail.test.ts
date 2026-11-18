// D75 at the botlingd level: a start that finds the last run unclosed and from another boot runs the store's
// `onLostTail` (log-store.ts lostTailRewind: every own stream gets a new logId); a clean restart does not.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Botlingd } from "../../src/server/botlingd";
import { openDb } from "../../src/server/store/sqlite";
import { botlingdEnv, testRoot } from "../botlingd-harness";
import { desktop } from "../helpers";

const LOST = /server\.db: the last run did not close before the machine restarted; \d+ stream\(s\) get a new logId \(D75\)/;

describe("botlingd: the D75 boot check", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  async function run(dataDir: string): Promise<string[]> {
    const lines: string[] = [];
    const daemon = await Botlingd.start({ env: botlingdEnv(dataDir), outDir: join(desktop, "out"), log: (line) => lines.push(line) });
    await daemon.stop();
    return lines;
  }

  it("rewinds the own streams after an unclosed run from another boot, not after a clean close", async () => {
    const root = testRoot("lost-tail");
    roots.push(root);
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    expect((await run(dataDir)).some((line) => LOST.test(line))).toBe(false);
    expect((await run(dataDir)).some((line) => LOST.test(line))).toBe(false);
    const db = openDb(join(dataDir, "server.db"));
    try {
      db.prepare("UPDATE meta SET value = '1' WHERE key = 'store.open'").run();
      db.prepare("UPDATE meta SET value = 'another-boot' WHERE key = 'store.boot'").run();
    } finally {
      db.close();
    }
    expect((await run(dataDir)).some((line) => LOST.test(line))).toBe(true);
  }, 120_000);
});
