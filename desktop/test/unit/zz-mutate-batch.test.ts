// TEMPORARY review driver (L-010 batch, one remote-test connection): applies each mutant to src, runs the related test files in a child vitest, restores. Removed after the review.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";

const WORKERS = "src/core/orchestration/plugin-workers.ts";
const WORLD = "src/core/server/plugin-world.ts";
const FILES = ["test/unit/orchestration-heard.test.ts", "test/unit/plugin-workers-installed.test.ts", "test/unit/orchestration-o05-book.test.ts", "test/unit/orchestration-primitives.test.ts"];
const mutants: Array<{ id: string; file: string; from: string; to: string }> = [
  { id: "M1 start drops plugin", file: WORKERS, from: "this.deps.world.workers(params.bot, plugin)", to: "this.deps.world.workers(params.bot)" },
  { id: "M2 admitHeard drops plugin", file: WORKERS, from: "this.deps.world.workers(botId, plugin)", to: "this.deps.world.workers(botId)" },
  { id: "M3 send drops plugin", file: WORKERS, from: "const port = this.deps.world.workers(entry.bot, entry.plugin);\n    if (typeof port === \"string\") throw new Error(port);\n    this.refuseWhileStopping", to: "const port = this.deps.world.workers(entry.bot);\n    if (typeof port === \"string\") throw new Error(port);\n    this.refuseWhileStopping" },
  { id: "M4 cancel drops plugin", file: WORKERS, from: "const port = this.deps.world.workers(entry.bot, entry.plugin);\n    if (typeof port === \"string\") throw new Error(port);\n    // O05", to: "const port = this.deps.world.workers(entry.bot);\n    if (typeof port === \"string\") throw new Error(port);\n    // O05" },
  { id: "M5 pickUp drops plugin", file: WORKERS, from: "const port = this.deps.world.workers(entry.bot, entry.plugin);\n        if (typeof port === \"string\" || !port.look)", to: "const port = this.deps.world.workers(entry.bot);\n        if (typeof port === \"string\" || !port.look)" },
  { id: "M6 Maintainer rule removed", file: WORLD, from: "if (bot.id === this.maintainerId && !(plugin !== undefined && MAINTAINER_WORKER_PLUGINS.has(plugin))) return", to: "if (false) return" },
  { id: "M7 missing plugin allowed", file: WORLD, from: "!(plugin !== undefined && MAINTAINER_WORKER_PLUGINS.has(plugin))", to: "!(plugin === undefined || MAINTAINER_WORKER_PLUGINS.has(plugin))" },
  { id: "M8 prefix match", file: WORLD, from: "MAINTAINER_WORKER_PLUGINS.has(plugin))) return", to: "[...MAINTAINER_WORKER_PLUGINS].some((n) => plugin.startsWith(n)))) return" },
  { id: "M9 allowlist empty", file: WORLD, from: 'new Set(["design-duel"])', to: "new Set<string>()" },
  { id: "M10 allowlist any plugin", file: WORLD, from: "!(plugin !== undefined && MAINTAINER_WORKER_PLUGINS.has(plugin))", to: "false" },
  { id: "M11 case-insensitive", file: WORLD, from: "MAINTAINER_WORKER_PLUGINS.has(plugin))) return", to: "MAINTAINER_WORKER_PLUGINS.has(plugin.toLowerCase().trim()))) return" },
];

function run(): { code: number | null; tail: string } {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")));
  const result = spawnSync("npx", ["vitest", "run", ...FILES, "--reporter=dot"], { env: { ...env, NO_COLOR: "1" }, encoding: "utf8", timeout: 600_000 });
  return { code: result.status, tail: (result.stdout + result.stderr).split("\n").filter((line) => /FAIL|Tests |Test Files/.test(line)).slice(0, 6).join(" | ") };
}

it("mutation batch", () => {
  const lines: string[] = [];
  const base = run();
  lines.push(`BASELINE exit=${base.code} ${base.tail}`);
  for (const mutant of mutants) {
    const original = readFileSync(mutant.file, "utf8");
    const count = original.split(mutant.from).length - 1;
    if (count !== 1) { lines.push(`${mutant.id}: NOT APPLIED (matches=${count})`); continue; }
    try {
      writeFileSync(mutant.file, original.replace(mutant.from, () => mutant.to));
      const result = run();
      lines.push(`${mutant.id}: ${result.code === 0 ? "SURVIVED" : "killed"} exit=${result.code} ${result.tail}`);
    } finally { writeFileSync(mutant.file, original); }
  }
  console.log("MUTATION-RESULTS\n" + lines.join("\n"));
}, 3_000_000);
