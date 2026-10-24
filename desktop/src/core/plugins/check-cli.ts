// `check-plugin <plugin folder>`: the checks 2.0 runs before loading a plugin (1.x: the Botling
// binary's --check-plugin), for Maintainer's release steps. Prints the problems; exits 1 if any.
import { resolve } from "node:path";
import { checkPlugin } from "./manifest";

const folder = process.argv[2];
if (!folder) {
  process.stderr.write("usage: check-plugin <plugin folder>\n");
  process.exit(2);
}
const problems = checkPlugin(resolve(folder));
if (problems.length) {
  for (const problem of problems) process.stdout.write(`✗ ${problem}\n`);
  process.exit(1);
}
process.stdout.write(`✓ ${resolve(folder)} passes the checks.\n`);
