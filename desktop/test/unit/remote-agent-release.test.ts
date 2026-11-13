// botling-agent's release (multi-machine phase 1, M3): the assets scripts/agent-release.mjs builds from the bundle the
// app ships, the install script run against a local server standing in for the GitHub release (checked against the
// SHA-256 Botling gives, or the release's checksums; a mismatch installs nothing), and the agent's own upgrade.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadAgent, upgradeAgent } from "../../src/remote/agent/install";
import { installCommand } from "../../src/remote/service";

const root = resolve(__dirname, "../..");
const bundle = join(root, "out/agent/botling-agent.cjs");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describe("botling-agent release", () => {
  let dir: string, server: Server, base: string;
  const served = new Map<string, Buffer>();
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "botling-agent-release-"));
    server = createServer((req, res) => {
      const body = served.get(req.url ?? "");
      if (!body) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Length": body.length }); res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); delete process.env.BOTLING_AGENT_RELEASES; });

  it("builds the agent, its install script and their checksums from the app's own bundle", async () => {
    expect(existsSync(bundle), "out/agent/botling-agent.cjs (node build.mjs)").toBe(true);
    const { agentRelease } = await import(/* @vite-ignore */ join(root, "scripts/agent-release.mjs"));
    const out = join(dir, "assets");
    const result = agentRelease(out);
    expect(result.files).toEqual([`botling-agent-${version}.cjs`, "botling-agent-install.sh", "SHA256SUMS-agent.txt"]);
    const agent = readFileSync(join(out, `botling-agent-${version}.cjs`));
    expect(agent.equals(readFileSync(bundle))).toBe(true);
    expect(result.sha).toBe(sha(agent));
    const script = readFileSync(join(out, "botling-agent-install.sh"), "utf8");
    expect(script).toContain(`VERSION="${version}"`);
    expect(script).not.toContain("@VERSION@");
    expect(script).toContain("https://github.com/william1010121/Botling/releases/download");
    const sums = readFileSync(join(out, "SHA256SUMS-agent.txt"), "utf8");
    expect(sums).toContain(`${sha(agent)}  botling-agent-${version}.cjs\n`);
    expect(spawnSync("sh", ["-n", join(out, "botling-agent-install.sh")]).status).toBe(0);
  });

  it("the install script names no variable right before a non-ASCII character (bash 3.2 reads it as part of the name)", () => {
    const script = readFileSync(join(root, "src/remote/agent/install.sh"), "utf8");
    expect(script.split("\n").filter((line) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line))).toEqual([]);
  });

  it("the install script installs only the file whose SHA-256 it was given", async () => {
    const out = join(dir, "assets");
    for (const name of [`botling-agent-${version}.cjs`, "botling-agent-install.sh", "SHA256SUMS-agent.txt"]) served.set(`/v${version}/${name}`, readFileSync(join(out, name)));
    const good = sha(readFileSync(bundle));
    // Async: the local server answers from this process.
    const run = (home: string, ...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn("sh", [join(out, "botling-agent-install.sh"), ...args, "--no-start"], { env: { ...process.env, HOME: home, BOTLING_AGENT_RELEASES: base, SHELL: "" } });
      let stdout = "", stderr = "";
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      child.on("close", (status) => done({ status, stdout, stderr }));
    });

    // A wrong SHA-256: nothing is run or installed.
    const bad = join(dir, "home-bad");
    mkdirSync(bad);
    const refused = await run(bad, "--sha", "0".repeat(64), "--no-pair");
    expect(refused, JSON.stringify(refused)).toMatchObject({ status: 1, stderr: expect.stringMatching(/does not match/) });
    expect(existsSync(join(bad, ".botling-agent"))).toBe(false);

    // The right one: installed with its launcher.
    const home = join(dir, "home-good");
    mkdirSync(home);
    const ok = await run(home, "--sha", good, "--no-pair");
    expect(ok.status, ok.stderr).toBe(0);
    const v = spawnSync(join(home, ".botling-agent/bin/botling-agent"), ["version"], { encoding: "utf8", env: { ...process.env, HOME: home, BOTLING_AGENT_NO_LOGIN_PATH: "1" } });
    expect(JSON.parse(v.stdout)).toMatchObject({ version, sha: good });

    // Without --sha: the release's checksums.
    const third = join(dir, "home-sums");
    mkdirSync(third);
    const sums = await run(third, "--no-pair");
    expect(sums.status, sums.stderr).toBe(0);
    expect(sums.stdout).toMatch(/release's checksums/);
    // Pairing needs the code.
    const noCode = await run(join(dir, "home-good"), "--sha", good);
    expect(noCode.status).toBe(1);
    expect(noCode.stderr).toMatch(/No pairing code/);
  }, 60_000);

  it("the agent upgrades itself only to the file Botling names, and the install line names it", async () => {
    process.env.BOTLING_AGENT_RELEASES = base;
    const next = Buffer.from("// botling-agent 9.9.9\n");
    served.set("/v9.9.9/botling-agent-9.9.9.cjs", next);
    const home = join(dir, "agent-home");
    mkdirSync(join(home, "lib"), { recursive: true });
    writeFileSync(join(home, "lib/botling-agent.cjs"), "old");

    await expect(upgradeAgent(home, { version: "9.9.9", sha: "1".repeat(64) }, "own")).rejects.toThrow(/not the one Botling runs/);
    expect(readFileSync(join(home, "lib/botling-agent.cjs"), "utf8")).toBe("old");
    await expect(upgradeAgent(home, { version: "../x", sha: sha(next) }, "own")).rejects.toThrow(/needs a version/);
    await expect(downloadAgent("1.0.404", "1".repeat(64))).rejects.toThrow(/HTTP 404/);
    expect(await upgradeAgent(home, { version: "9.9.9", sha: sha(next) }, sha(next))).toEqual({ installed: false, sha: sha(next) });

    expect(await upgradeAgent(home, { version: "9.9.9", sha: sha(next) }, "own")).toEqual({ installed: true, sha: sha(next) });
    expect(readFileSync(join(home, "lib/botling-agent.cjs")).equals(next)).toBe(true);
    expect(existsSync(join(home, "bin/botling-agent"))).toBe(true);

    const line = installCommand("botling-machine1.abc", sha(next), "9.9.9");
    expect(line).toBe(`curl -fsSL ${base}/v9.9.9/botling-agent-install.sh | sh -s -- --sha ${sha(next)} 'botling-machine1.abc'`);
    expect(installCommand("botling-machine1.abc", "", "9.9.9")).not.toContain("--sha");
  });
});
