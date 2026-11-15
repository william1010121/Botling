// Botling 3 M2 step 5: the built botlingd's pairing commands (out/server/main.cjs under plain Node, no window, no
// network listener): `botlingd pair` makes the cluster only after the recovery code is typed back (the status note says
// so meanwhile), prints the link; `devices`, `revoke-device`; a restart keeps the cluster; the code is nowhere in the
// data folder. Needs `npm run build` first (test:changed does it).
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { parsePairLink } from "../../src/protocol";
import { BotlingdProcess, botlingdCommand, botlingdEnv, botlingdScript, testRoot } from "../botlingd-harness";
import { until } from "../helpers";

const root = testRoot("pairing-cli");
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `botlingd pair` with a pipe for its stdin and every stdout line kept. */
function pairProcess(dataDir: string, args: string[] = []) {
  const child = spawn(process.execPath, ["--no-warnings", botlingdScript, "pair", "--no-qr", ...args], { env: botlingdEnv(dataDir), stdio: "pipe" });
  const lines: string[] = [];
  let stderr = "";
  createInterface({ input: child.stdout }).on("line", (line) => lines.push(line));
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  return {
    lines, closed, child,
    stderr: () => stderr,
    line: (test: (line: string) => boolean, what: string) => until(() => {
      const found = lines.find(test);
      if (!found && child.exitCode !== null) throw new Error(`botlingd pair exited ${child.exitCode} before ${what}\n${lines.join("\n")}\n${stderr}`);
      return found;
    }, { timeout: 30_000, what }),
    type: (text: string) => { child.stdin.write(`${text}\n`); },
  };
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...filesUnder(path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

describe("botlingd pair / devices / revoke-device (built, plain Node)", () => {
  it("the first pairing makes the cluster only after the code is typed back; status notes it meanwhile; a restart keeps the cluster", async () => {
    const dir = join(root, "d1");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    expect(botlingdCommand(dir, ["pair"]).code).toBe(3); // not running
    let daemon = new BotlingdProcess(dir);
    let pair: ReturnType<typeof pairProcess> | null = null;
    try {
      await daemon.ready();
      expect(botlingdCommand(dir, ["status"]).stdout).toContain("cluster: none yet");

      pair = pairProcess(dir);
      const codeLine = (await pair.line((line) => /^\s+([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/.test(line), "the recovery code")).trim();
      const created = await pair.line((line) => /^This is the first pairing, so it created your Botling cluster \([0-9a-f]{32}\)\.$/.test(line), "the cluster");
      const clusterId = created.match(/\(([0-9a-f]{32})\)/)![1]!;
      await pair.line((line) => line.startsWith("Press Enter once you have saved it"), "the prompt");
      // Made at once: nothing is typed back, and status no longer says "none yet".
      expect(botlingdCommand(dir, ["status"]).stdout).not.toContain("cluster: none yet");
      pair.type("");
      const link = await pair.line((line) => line.startsWith("https://"), "the link");
      const offer = parsePairLink(link)!;
      expect(offer.cluster).toBe(clusterId);
      expect(link.startsWith("https://tailnet-name.invalid/v3/#pair=")).toBe(true);
      await pair.line((line) => line.startsWith("Note: no tailnet address is set yet"), "the placeholder note");
      await pair.line((line) => line.startsWith("Waiting for the device"), "waiting");
      pair.child.kill("SIGTERM");
      await pair.closed;
      pair = null;

      const status = botlingdCommand(dir, ["status"]);
      expect(status.stdout).toContain(`cluster: ${clusterId}`);
      expect(status.stdout).not.toContain("not typed back");
      expect(botlingdCommand(dir, ["devices"]).stdout.trim()).toBe("No devices are paired.");
      expect(JSON.parse(botlingdCommand(dir, ["devices", "--json"]).stdout)).toEqual([]);
      const revoke = botlingdCommand(dir, ["revoke-device", "zzzzzzzzzzzzzzzzzzzzzzzzzz", "--reason", "test"]);
      expect(revoke.code).toBe(1);
      expect(revoke.stdout).toMatch(/Cannot revoke zzzzzzzzzzzzzzzzzzzzzzzzzz: not-a-device/);
      expect(botlingdCommand(dir, ["revoke-device"]).code).toBe(2);

      expect(await daemon.stop()).toBe(0);
      daemon = new BotlingdProcess(dir);
      await daemon.ready();
      expect(daemon.log).toContain(`cluster ${clusterId}`);
      expect(botlingdCommand(dir, ["status"]).stdout).toContain(`cluster: ${clusterId}`);
      // A second pairing goes straight to the link: the cluster is not made again.
      pair = pairProcess(dir, ["--name", "Tablet", "--scope", "read"]);
      const second = parsePairLink(await pair.line((line) => line.startsWith("https://"), "the second link"))!;
      expect(second.cluster).toBe(clusterId);
      expect(second.offer).not.toBe(offer.offer);
      expect(pair.lines.some((line) => line.startsWith("Recovery code") || line.includes("first pairing"))).toBe(false);
      pair.child.kill("SIGTERM");
      await pair.closed;
      pair = null;
      expect(botlingdCommand(dir, ["pair", "--scope", "everything"]).code).toBe(2);

      expect(await daemon.stop()).toBe(0);
      // The recovery code and the offer secrets are in no file of the data folder (server.db, WAL, keys, log, backups).
      const normal = codeLine.replace(/-/g, "");
      for (const file of filesUnder(dir)) {
        const text = readFileSync(file).toString("latin1");
        expect(text.includes(normal) || text.includes(codeLine), file).toBe(false);
        expect(text.includes(offer.secret) || text.includes(second.secret), file).toBe(false);
      }
    } finally {
      if (pair) { pair.child.kill("SIGKILL"); await pair.closed; }
      await daemon.stop();
    }
  });
});
