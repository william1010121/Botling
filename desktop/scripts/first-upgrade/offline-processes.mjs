import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
const exec = promisify(execFile);
const under = (path, root) => path === root || path.startsWith(root + '/');
const fail = message => { throw new Error(message); };

// Parse complete ps records, retaining start time to distinguish reused PIDs.
// Neither raw commands nor open-file paths are emitted by the CLI.
export function parseProcesses(stdout, argvText, { reconcileMissing } = {}) {
  const argv = new Map();
  for (const line of argvText.split('\n').filter(x => x.trim())) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m || argv.has(Number(m[1]))) fail('Uncertain process arguments');
    argv.set(Number(m[1]), m[2]);
  }
  const rows = [];
  for (const line of stdout.split('\n').filter(x => x.trim())) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(line);
    if (!m) fail('Uncertain process identity');
    const pid = Number(m[1]);
    if (!argv.has(pid)) {
      const restored = reconcileMissing?.({ pid, ppid: Number(m[2]), uid: Number(m[3]), start: m[4].replace(/\s+/g, ' '), executable: m[5] });
      if (restored) argv.set(pid, restored);
    }
    if (!argv.has(pid)) {
      if (m[5] === '/bin/ps' || m[5] === 'ps') continue;
      fail('Process changed during census; retry after quiescence');
    }
    rows.push({ pid, ppid: Number(m[2]), uid: Number(m[3]), start: m[4].replace(/\s+/g, ' '), executable: m[5], args: argv.get(pid) });
  }
  if (!rows.length || new Set(rows.map(p => p.pid)).size !== rows.length) fail('Incomplete process census');
  return rows;
}
export function parseOpenFiles(stdout) {
  let pid = null;
  const entries = [];
  for (const raw of stdout.split('\0')) {
    const field = raw.replace(/^\n+/, '');
    if (!field) continue;
    const kind = field[0], value = field.slice(1);
    if (kind === 'p') { if (!/^\d+$/.test(value)) fail('Uncertain open-file PID'); pid = Number(value); }
    else if (kind === 'n') { if (pid === null || /[\r\n]/.test(value)) fail('Uncertain open-file identity'); entries.push({ pid, path: value }); }
    else if (!['c', 'f'].includes(kind)) fail('Unexpected open-file census field');
  }
  if (pid === null) fail('Empty open-file census');
  return entries;
}
export async function findWriters(processes, files, { appPath, dataDir, allowed = [] }, canonical = realpath) {
  const exempt = new Set(allowed.filter(a => processes.some(p => p.pid === a.pid && p.ppid === a.ppid && p.uid === a.uid && p.start === a.start && p.executable === a.executable && p.args === a.args)).map(a => a.pid));
  const found = new Set();
  for (const p of processes) {
    if (exempt.has(p.pid)) continue;
    // Any Botling main/helper or core candidate is conservative refusal, including
    // another installed copy whose destination profile cannot be established.
    if (under(p.executable, appPath) || /Botling[^/]*\.app\//i.test(p.executable)
      || p.args.includes(dataDir) || p.args.includes(appPath)
      || /(?:^|[/ ])(?:main\.cjs|botling-core|ClaudeCodeBot)(?:\s|$)/i.test(p.args)) found.add(p.pid);
  }
  for (const file of files) {
    if (exempt.has(file.pid) || !file.path.startsWith('/')) continue;
    if (/\\[0-7]{3}|\(deleted\)$/.test(file.path)) {
      if (file.path.includes('Botling') || file.path.includes(dataDir)) fail('Uncertain deleted/escaped profile handle');
    }
    // Resolving named paths detects symlink aliases into the profile/app.
    let resolved;
    try { resolved = await canonical(file.path); }
    catch {
      // Unresolvable non-target OS handles are common (pipes, removed temp files).
      // A direct target reference remains a writer even if it disappeared.
      resolved = file.path;
    }
    if ([file.path, resolved].some(path => under(path, appPath) || under(path, dataDir))) found.add(file.pid);
  }
  return [...found].sort((a, b) => a - b);
}
const command = async (file, args) => {
  const { stdout, stderr } = await exec(file, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } });
  if (stderr.trim()) fail('Process inspection incomplete; no maintenance permitted');
  return stdout;
};
const helperTools = new Set(['/bin/sh', '/bin/bash', '/usr/bin/ditto', '/usr/bin/du', '/bin/mv', '/usr/bin/stat', '/bin/df', '/usr/bin/awk', '/bin/rm', '/bin/mkdir', '/usr/bin/plutil', '/bin/cat', '/bin/sleep', '/bin/sync', '/bin/ln']);
export function transactionProcesses(processes, h) {
  if (!h) return [];
  const roots = processes.filter(p => h.identity && ['pid', 'ppid', 'uid', 'start'].every(k => p[k] === h.identity[k])
    && p.executable === '/bin/sh' && p.args === h.args);
  const candidates = roots.length && h.candidate ? processes.filter(p => p.ppid === h.pid && p.executable === h.candidate.executable
    && p.args.includes('--botling-update-token=' + h.candidate.token)
    && p.args.includes('--botling-maintenance-launch=' + h.candidate.token)) : [];
  const candidateTree = [...candidates];
  for (let pass = 0; pass < processes.length; pass++) {
    const additions = processes.filter(p => !candidateTree.some(o => o.pid === p.pid) && h.candidate && under(p.executable, h.candidate.appPath)
      && candidateTree.some(o => o.pid === p.ppid));
    if (!additions.length) break;
    candidateTree.push(...additions);
  }
  const owned = [...roots, ...candidateTree];
  for (let pass = 0; pass < processes.length; pass++) {
    const additions = processes.filter(p => !owned.some(o => o.pid === p.pid) && helperTools.has(p.executable) && (!['/bin/sh', '/bin/bash'].includes(p.executable) || p.args === h.args) && owned.some(o => o.pid === p.ppid));
    if (!additions.length) break;
    owned.push(...additions);
  }
  return owned;
}
export function createWriterCheck({ appPath, dataDir, uid = process.getuid(), allowed = [], helper = () => null, ownership }, run = command) {
  return async () => {
    const finishCensus = ownership?.beginCensus?.(); let accepted = false;
    try {
      // Deliberately serial: compare identities around open-file enumeration.
      const identity = await run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,uid=,lstart=,comm=']);
      const args = await run('/bin/ps', ['-axww', '-o', 'pid=,args=']);
      const reconcile = { reconcileMissing: row => ownership?.reconcileExited?.(row) };
      const processes = parseProcesses(identity, args, reconcile);
      const self = processes.find(p => p.pid === process.pid);
      if (!self || self.uid !== uid) fail('Cannot bind bootstrap process identity');
      const files = parseOpenFiles(await run('/usr/sbin/lsof', ['-nP', '-a', '-u', String(uid), '-F0pcfn']));
      const later = parseProcesses(await run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,uid=,lstart=,comm=']), await run('/bin/ps', ['-axww', '-o', 'pid=,args=']), reconcile);
      const h = helper();
      const helpers = [...transactionProcesses(processes, h), ...transactionProcesses(later, h)];
      const registered = ownership ? await ownership.attestObservations(processes, later) : [];
      const options = { appPath, dataDir, allowed: [self, ...allowed, ...helpers, ...registered] };
      const writers = new Set([...await findWriters(processes, files, options), ...await findWriters(later, files, options)]);
      if (writers.size) fail(`Maintenance refused: app/core/profile references remain (PIDs ${[...writers].join(', ')}). Quit normally and retry.`);
      accepted = true;
      return { checkedAt: new Date().toISOString(), scope: 'manual-no-relaunch-window', observedWriters: 0, helperPresent: !!h && [...helpers, ...registered].some(p => p.pid === h.pid) };
    } finally { finishCensus?.(accepted); }
  };
}
