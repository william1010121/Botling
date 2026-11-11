// The ssh path to a machine (multi-machine phase 1): every connection is one `ssh <host> botling-agent serve`
// process whose stdio carries the frames. Trust is the host key: Botling scans it, shows its fingerprint, and the
// user approves it (the model's Pair, Approve); Botling keeps approved keys in its own known_hosts file under an
// alias per machine (`botling-<id>`), so ssh checks the key strictly and the user's ~/.ssh/known_hosts is not touched.
// The agent is Botling's own bundle, uploaded over the same ssh when the machine has none or another version (Upgrade).
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_NO_NODE, LineReader, parseFrame, type UpFrame } from "./protocol";
import { FrameLink } from "./link";
import type { LinkHandlers, SessionLink, SessionTransport } from "./session";

/** Quotes a word for a POSIX shell (and for fish, which joins quoted pieces the same way). */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The agent's launcher on the machine: finds Node 18+ (also on the login shell's PATH, e.g. nvm), then runs the bundle. */
export const LAUNCHER = `#!/bin/sh
# botling-agent launcher, installed by Botling (multi-machine). Runs lib/botling-agent.cjs with Node 18+.
dir="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "$SHELL" ] && [ -z "$BOTLING_AGENT_NO_LOGIN_PATH" ]; then
  p="$("$SHELL" -lc 'printf "\\n__BOTLING_PATH__%s\\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^__BOTLING_PATH__//p' | tail -n 1)"
  [ -n "$p" ] && PATH="$p:$PATH" && export PATH
fi
node="\${BOTLING_AGENT_NODE:-$(command -v node 2>/dev/null)}"
if [ -z "$node" ]; then echo "botling-agent: Node.js was not found on this machine (Botling needs Node 18 or newer)." >&2; exit ${EXIT_NO_NODE}; fi
major="$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
if [ "\${major:-0}" -lt 18 ] 2>/dev/null; then echo "botling-agent: Node $("$node" --version) is too old (Botling needs Node 18 or newer)." >&2; exit ${EXIT_NO_NODE}; fi
exec "$node" "$dir/lib/botling-agent.cjs" "$@"
`;

const SERVE = `exec "$HOME/.botling-agent/bin/botling-agent" serve`;

export interface SshMachine {
  id: string;
  /** The alias in ~/.ssh/config (or user@host). */
  host: string;
}

export interface SshTransportOptions {
  machine: SshMachine;
  /** Botling's known_hosts file (approved host keys, under `botling-<id>`). */
  knownHosts: string;
  /** The agent bundle to upload (out/agent/botling-agent.cjs). */
  bundle: string;
  /** The ssh program (tests: a fake that runs the command here). */
  ssh?: string;
  /** Extra ssh options. */
  args?: string[];
  log?(line: string): void;
}

export const hostAlias = (id: string) => `botling-${id}`;

/** The options every Botling ssh call uses: no prompts, the host key checked strictly against Botling's own file. */
export function sshOptions(machine: SshMachine, knownHosts: string, extra: string[] = []): string[] {
  return [
    "-T", "-x", "-a",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", `HostKeyAlias=${hostAlias(machine.id)}`,
    "-o", "UpdateHostKeys=no",
    "-o", "ConnectTimeout=20",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "LogLevel=ERROR",
    ...controlOptions(),
    ...extra,
    "--", machine.host,
  ];
}

/** Connection sharing: the sessions of one machine reuse one ssh connection (much faster to connect). */
function controlOptions(): string[] {
  if (process.env.BOTLING_SSH_NO_CONTROL === "1") return [];
  let dir: string;
  try { dir = join("/tmp", `botling-ssh-${userInfo().uid}`); mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return []; }
  return ["-o", "ControlMaster=auto", "-o", `ControlPath=${dir}/%C`, "-o", "ControlPersist=60"];
}

/** Why an ssh process failed, said for the user. */
export function sshError(code: number | null, stderr: string, host: string): string {
  const text = stderr.trim().split("\n").filter((l) => l.trim()).slice(-3).join(" ");
  if (code === EXIT_NO_NODE) return text || `Node.js 18 or newer is needed on ${host}.`;
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return `The host key of ${host} is not the one you approved. If the machine was reinstalled, remove it in Settings › Machines and add it again.`;
  if (/permission denied/i.test(stderr)) return `ssh to ${host} was refused (${text}). Botling uses your ssh keys and agent without prompts: check that \`ssh ${host}\` works without a password.`;
  if (/could not resolve|connection refused|timed out|no route|network is unreachable/i.test(stderr)) return `Could not reach ${host}: ${text}`;
  return text ? `ssh to ${host}: ${text}` : `ssh to ${host} ended (exit ${code ?? "signal"}).`;
}

export class SshTransport implements SessionTransport {
  private upgrading: Promise<void> | null = null;
  constructor(readonly options: SshTransportOptions) {}

  private get ssh() { return this.options.ssh ?? process.env.BOTLING_SSH ?? "ssh"; }
  private args(command: string) {
    return [...sshOptions(this.options.machine, this.options.knownHosts, this.options.args), `sh -c ${shq(command)}`];
  }

  /** Opens connection g: one ssh process running `botling-agent serve`. */
  open(session: string, gen: number, handlers: LinkHandlers): SessionLink {
    const child = spawn(this.ssh, this.args(SERVE), { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let heard = false;
    let ended = false;
    const end = (error?: string) => {
      if (ended) return;
      ended = true;
      link.end(error);
      handlers.closed(error);
    };
    const link = new FrameLink(
      (frame) => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(frame)}\n`); },
      (frame: UpFrame) => { heard = true; handlers.frame(frame); },
    );
    const reader = new LineReader((line) => { const frame = parseFrame(line); if (frame) link.receive(frame); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => reader.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8_000); });
    child.stdin.on("error", () => { /* ssh went away; 'close' says why */ });
    child.on("error", (error) => end(`Could not run ssh: ${error.message}`));
    child.on("close", (code) => {
      // No agent there (or not one this launcher can run): the model's `hi` from an agent of another version.
      if (!heard && (code === 127 || /botling-agent: (not found|No such file)|botling-agent.*not found/i.test(stderr))) {
        handlers.frame({ t: "hi", s: session, g: gen, v: "", sha: "" });
        end();
        return;
      }
      end(code === 0 ? undefined : sshError(code, stderr, this.options.machine.host));
    });
    return {
      send: (frame) => link.send(frame),
      close: () => { if (!child.stdin.destroyed) child.stdin.end(); setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }, 5_000).unref?.(); },
      rpc: (op, args) => link.rpc(op, args),
      sendBlob: (data) => link.sendBlob(data),
      takeBlob: (id) => link.takeBlob(id),
    };
  }

  /** Uploads the app's agent and its launcher to ~/.botling-agent (replacing whatever is there, atomically). */
  upgrade(): Promise<void> {
    if (!this.upgrading) this.upgrading = this.install().finally(() => { this.upgrading = null; });
    return this.upgrading;
  }

  private install(): Promise<void> {
    const bundle = readFileSync(this.options.bundle);
    const script = [
      "umask 077", 'd="$HOME/.botling-agent"', 'mkdir -p "$d/bin" "$d/lib"',
      'cat > "$d/lib/botling-agent.cjs.new"',
      `[ "$(wc -c < "$d/lib/botling-agent.cjs.new" | tr -d ' ')" = "${bundle.length}" ] || { echo "botling-agent: upload was cut short" >&2; exit 3; }`,
      'mv -f "$d/lib/botling-agent.cjs.new" "$d/lib/botling-agent.cjs"',
      `printf '%s' ${shq(LAUNCHER)} > "$d/bin/botling-agent.new"`,
      'chmod 700 "$d/bin/botling-agent.new"', 'mv -f "$d/bin/botling-agent.new" "$d/bin/botling-agent"',
      '"$d/bin/botling-agent" version',
    ].join(" && ");
    return new Promise((resolve, reject) => {
      const child = spawn(this.ssh, this.args(script), { stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.setEncoding("utf8").on("data", (c: string) => { out += c; });
      child.stderr.setEncoding("utf8").on("data", (c: string) => { err = (err + c).slice(-8_000); });
      child.on("error", (error) => reject(new Error(`Could not run ssh: ${error.message}`)));
      child.stdin.on("error", () => { /* 'close' says why */ });
      child.on("close", (code) => {
        if (code !== 0) { reject(new Error(sshError(code, err, this.options.machine.host))); return; }
        this.options.log?.(`installed botling-agent on ${this.options.machine.host}: ${out.trim().split("\n").pop()}`);
        resolve();
      });
      child.stdin.end(bundle);
    });
  }

  /** Runs `botling-agent info` there (Settings › Machines check). */
  info(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      execFile(this.ssh, this.args(`exec "$HOME/.botling-agent/bin/botling-agent" info`), { timeout: 60_000, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) { reject(new Error(sshError(typeof error.code === "number" ? error.code : null, stderr, this.options.machine.host))); return; }
        try { resolve(JSON.parse(stdout.trim().split("\n").pop() ?? "{}")); } catch { reject(new Error(`botling-agent info on ${this.options.machine.host} said: ${stdout.slice(0, 300)}`)); }
      });
    });
  }
}

/** The SHA-256 of a file (the agent bundle the app would upload). */
export function fileSha(file: string): string {
  try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return ""; }
}

// ---- Adding a host (Settings › Machines): its aliases, its host key.

/** The hosts named in ~/.ssh/config (and the files it includes), without patterns. */
export function sshConfigHosts(file = join(homedir(), ".ssh", "config"), seen = new Set<string>()): string[] {
  if (seen.has(file) || seen.size > 20) return [];
  seen.add(file);
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const hosts: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^(\w+)\s*=?\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const words = m[2]!.split(/\s+/).map((w) => w.replace(/^"|"$/g, ""));
    if (key === "host") for (const w of words) { if (!/[*?!]/.test(w) && !hosts.includes(w)) hosts.push(w); }
    if (key === "include") {
      for (const w of words) {
        const path = w.startsWith("~") ? join(homedir(), w.slice(1)) : w.startsWith("/") ? w : join(homedir(), ".ssh", w);
        if (/[*?]/.test(path)) {
          try {
            const dir = dirname(path), pattern = new RegExp(`^${path.slice(dir.length + 1).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
            for (const name of readdirSync(dir)) if (pattern.test(name)) hosts.push(...sshConfigHosts(join(dir, name), seen).filter((h) => !hosts.includes(h)));
          } catch { /* no such folder */ }
        } else hosts.push(...sshConfigHosts(path, seen).filter((h) => !hosts.includes(h)));
      }
    }
  }
  return hosts;
}

const run = (command: string, args: string[], input?: string) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
  const child = execFile(command, args, { timeout: 30_000, encoding: "utf8" }, (error, out, err) => {
    resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out, err });
  });
  if (input !== undefined) child.stdin?.end(input);
});

export interface ScannedKey { hostname: string; port: number; lines: string[]; fingerprint: string; known: boolean }

/** Pair: the host's keys as ssh sees them (via ~/.ssh/config), their fingerprint, and whether ~/.ssh/known_hosts already trusts them. */
export async function scanHostKey(host: string): Promise<ScannedKey> {
  const g = await run("ssh", ["-G", "--", host]);
  if (g.code !== 0) throw new Error(`ssh does not know ${host}: ${g.err.trim()}`);
  const conf = new Map<string, string>();
  for (const line of g.out.split("\n")) { const at = line.indexOf(" "); if (at > 0 && !conf.has(line.slice(0, at))) conf.set(line.slice(0, at), line.slice(at + 1).trim()); }
  const hostname = conf.get("hostname") ?? host, port = Number(conf.get("port") ?? 22);
  if (conf.get("proxycommand") || conf.get("proxyjump")) {
    // Behind a jump host keyscan cannot reach it; ask ssh itself (it prints the key it was offered).
    throw new Error(`${host} goes through a ProxyJump/ProxyCommand; Botling cannot scan its host key yet. Add it as a relay machine instead.`);
  }
  const scan = await run("ssh-keyscan", ["-T", "10", "-p", String(port), "-t", "ed25519,ecdsa,rsa", "--", hostname]);
  const keys = scan.out.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/).slice(1, 3).join(" ")).filter((l) => /^\S+ \S+$/.test(l));
  if (!keys.length) throw new Error(`Could not read the host key of ${host} (${hostname}:${port}): ${scan.err.trim().split("\n").pop() ?? "no answer"}`);
  const best = keys.find((k) => k.startsWith("ssh-ed25519")) ?? keys[0]!;
  const fp = await run("ssh-keygen", ["-l", "-E", "sha256", "-f", "-"], `x ${best}\n`);
  const fingerprint = /SHA256:\S+/.exec(fp.out)?.[0] ?? "";
  if (!fingerprint) throw new Error(`Could not read the fingerprint of ${host}'s host key.`);
  const name = port === 22 ? hostname : `[${hostname}]:${port}`;
  let known = false;
  for (const file of [join(homedir(), ".ssh", "known_hosts"), join(homedir(), ".ssh", "known_hosts2")]) {
    if (!existsSync(file)) continue;
    const found = await run("ssh-keygen", ["-F", name, "-f", file]);
    if (found.code === 0 && keys.some((k) => found.out.includes(k.split(" ")[1]!))) known = true;
  }
  return { hostname, port, lines: keys, fingerprint, known };
}

/** Writes Botling's known_hosts: the approved keys of trusted ssh machines, each under its alias. */
export function writeKnownHosts(file: string, machines: { id: string; keys: string[] }[]) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const text = machines.flatMap((m) => m.keys.map((k) => `${hostAlias(m.id)} ${k}`)).join("\n");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text ? `${text}\n` : "", { mode: 0o600 });
  renameSync(tmp, file);
}
