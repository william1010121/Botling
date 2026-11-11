// The botling-agent release assets (multi-machine phase 1, M3), from the bundle the app ships (out/agent/
// botling-agent.cjs, so its SHA-256 is the one Botling sends with every install line and upgrade):
//   <dir>/botling-agent-<version>.cjs     the agent
//   <dir>/botling-agent-install.sh        the install script of that version
//   <dir>/SHA256SUMS-agent.txt            both files' SHA-256
// Builds files only; publishing is the release workflow's.
//   node scripts/agent-release.mjs <dir>     (run `npm run build` first)
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
export const RELEASES = "https://github.com/william1010121/Botling/releases/download";

export function agentRelease(dir, { bundle = join(root, "out/agent/botling-agent.cjs"), version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, releases = RELEASES } = {}) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(version)) throw new Error(`Bad version ${version}`);
  let agent;
  try { agent = readFileSync(bundle); } catch { throw new Error(`${bundle} is missing: run npm run build first`); }
  const script = readFileSync(join(root, "src/remote/agent/install.sh"), "utf8").replaceAll("@VERSION@", version).replaceAll("@RELEASES@", releases);
  mkdirSync(dir, { recursive: true });
  const files = { [`botling-agent-${version}.cjs`]: agent, "botling-agent-install.sh": Buffer.from(script) };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data, { mode: name.endsWith(".sh") ? 0o755 : 0o644 });
  const sums = Object.entries(files).map(([name, data]) => `${createHash("sha256").update(data).digest("hex")}  ${name}`).join("\n") + "\n";
  writeFileSync(join(dir, "SHA256SUMS-agent.txt"), sums);
  return { files: [...Object.keys(files), "SHA256SUMS-agent.txt"], sha: createHash("sha256").update(agent).digest("hex") };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: node scripts/agent-release.mjs <dir>"); process.exit(2); }
  const { files, sha } = agentRelease(resolve(dir));
  console.log(`botling-agent release assets in ${dir}: ${files.join(", ")} (agent SHA-256 ${sha})`);
}
