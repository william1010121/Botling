// Botling performance benchmark: `npm run perf` (see desktop/docs/performance.md).
//
// Builds the core, writes synthetic data folders (synth.mjs: real chat.json / projects.json / subagents
// shapes), starts the core on each over its stdio transport exactly as main does, and measures
//   startup    spawn -> first chat.snapshot answered, and the core's resident memory then
//   open chat  the chat.snapshot of the big chat: bytes sent to the renderer and how long it takes
//   append     the core's per-message cost on that chat (view + chat.json rewrite), in process
// Results go to stdout as a table and to .cache/perf/results.json. With --check (the default under CI) a
// number above its budget in budgets.json fails the run. `--update-budgets` is deliberately not offered:
// a budget changes in a reviewed commit, with the measurement that justifies it.
import { build } from "esbuild";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeData } from "./synth.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cache = join(desktop, ".cache", "perf");
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const check = !args.includes("--no-check");
const budgets = JSON.parse(readFileSync(join(desktop, "scripts/perf/budgets.json"), "utf8"));

// Never touch real data or inherit a developer's settings.
for (const key of Object.keys(process.env)) if (key.startsWith("BOTLING_")) delete process.env[key];

rmSync(cache, { recursive: true, force: true });
mkdirSync(cache, { recursive: true });
const node = { bundle: true, platform: "node", format: "cjs", target: "node22", sourcemap: false, logLevel: "error", absWorkingDir: desktop, preserveSymlinks: true };
await Promise.all([
  build({ ...node, entryPoints: [join(desktop, "src/core/main.ts")], outfile: join(cache, "core.cjs") }),
  build({ ...node, entryPoints: [join(desktop, "scripts/perf/inproc.ts")], outfile: join(cache, "inproc.cjs") }),
]);

const SCENARIOS = {
  // The floor: a new install.
  empty: { main: { count: 0 } },
  // Fifty bots with a normal chat each, and subagent histories (PR #40's store).
  bots50: { main: { count: 200, steps: 2, outputBytes: 1000 }, bots: 50, bot: { count: 200, steps: 2, outputBytes: 1000 }, subagents: { count: 40, steps: 200, outputBytes: 500 }, big: false },
  // The 500 lines chat.json keeps, each answer with 10 tool steps of 6 KB: a long coding session.
  chat500: { main: { count: 500, steps: 10, outputBytes: 6000, bigEvery: 25, bigText: 120_000 } },
  // A chat file that outgrew the cap (a long-running session saved late, or a file from another build).
  chat5k: { main: { count: 5000, steps: 1, outputBytes: 300 } },
  chat20k: { main: { count: 20000, steps: 0 } },
};

const rss = (pid) => Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) / 1024;
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

async function runCore(root, home) {
  const started = performance.now();
  const child = spawn(process.execPath, [join(cache, "core.cjs")], {
    env: { PATH: process.env.PATH, HOME: home, BOTLING_DATA_DIR: root, BOTLING_AGENT: "fake" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr = (stderr + c).slice(-4000); });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.startsWith('{"id"') || line.startsWith('{"v"')) {
      const id = line.slice(0, 200).match(/"id":"([^"]+)"/)?.[1];
      const resolveFn = id && waiting.get(id);
      if (resolveFn) { waiting.delete(id); resolveFn(line); }
    }
  });
  let n = 0;
  const call = (cmd, timeout = 120_000) => new Promise((ok, fail) => {
    const id = `p${++n}`;
    const timer = setTimeout(() => fail(new Error(`no answer to ${cmd.type}\n${stderr}`)), timeout);
    waiting.set(id, (line) => { clearTimeout(timer); ok(line); });
    child.stdin.write(JSON.stringify({ v: 10, id, cmd }) + "\n");
  });
  child.on("exit", (code) => { if (waiting.size) console.error(`core exited ${code}\n${stderr}`); });
  return { child, call, started, stop: () => { child.kill("SIGKILL"); } };
}

async function scenario(name, spec) {
  const root = join(cache, name, "data"), home = join(cache, name, "home");
  mkdirSync(home, { recursive: true });
  writeData(root, spec);
  const bytes = statSync(join(root, "main", "chat.json")).size;
  const core = await runCore(root, home);
  const first = await core.call({ type: "chat.snapshot" });
  const startupMs = performance.now() - core.started;
  const firstBytes = Buffer.byteLength(first);
  // Open the chat again, as the renderer does when the window or a bot is opened, and take the best of three.
  const opens = [];
  let openBytes = 0;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const line = await core.call({ type: "chat.snapshot", botId: "6A0B0000-0000-4000-8000-000000000002" });
    opens.push(performance.now() - t);
    openBytes = Buffer.byteLength(line);
  }
  await new Promise((r) => setTimeout(r, 300));
  const memory = rss(core.child.pid);
  core.stop();
  const result = { chatFileMB: round(bytes / 1048576), startupMs: round(startupMs, 0), firstSnapshotMB: round(firstBytes / 1048576), openChatMs: round(Math.min(...opens), 0), openChatMB: round(openBytes / 1048576), coreRssMB: round(memory, 0) };
  // The in-process costs (own heap, append) on the main chat.
  const inproc = JSON.parse(execFileSync(process.execPath, ["--expose-gc", join(cache, "inproc.cjs"), join(root, "main"), join(cache, name, "scratch")], { maxBuffer: 1 << 20 }).toString());
  Object.assign(result, { loadMs: inproc.loadMs, viewsMs: inproc.viewsMs, heapMB: inproc.heapMB, appendSaveMs: inproc.appendSaveMs, appendViewMs: inproc.appendViewMs, records: inproc.records });
  return result;
}

const results = {};
for (const [name, spec] of Object.entries(SCENARIOS)) {
  if (only && only !== name) continue;
  process.stdout.write(`${name} ... `);
  results[name] = await scenario(name, spec);
  console.log(JSON.stringify(results[name]));
}
writeFileSync(join(cache, "results.json"), JSON.stringify(results, null, 2));

// Table.
const keys = ["records", "chatFileMB", "startupMs", "firstSnapshotMB", "openChatMs", "openChatMB", "coreRssMB", "loadMs", "viewsMs", "heapMB", "appendSaveMs", "appendViewMs"];
console.log("\n" + ["scenario".padEnd(9), ...keys.map((k) => k.padStart(15))].join(" "));
for (const [name, r] of Object.entries(results)) console.log([name.padEnd(9), ...keys.map((k) => String(r[k]).padStart(15))].join(" "));

// Budgets.
const failures = [];
for (const [name, r] of Object.entries(results)) for (const [key, limit] of Object.entries(budgets[name] ?? {})) {
  if (r[key] > limit) failures.push(`${name}.${key} = ${r[key]} is over its budget of ${limit}`);
}
if (failures.length) {
  console.error(`\nPerformance budget exceeded:\n  ${failures.join("\n  ")}\nSee desktop/docs/performance.md.`);
  if (check) process.exit(1);
} else console.log("\nAll budgets met.");
