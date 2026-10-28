import childProcess from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseProcesses } from './offline-processes.mjs';
// -p suppresses shell startup/function injection; it does not change the UID.
const GATE = 'IFS= read -r -t 5 permit || exit 125; [ "$permit" = go ] || exit 125; exec "$@"';
const sameIdentity = (a, b) => ['pid', 'ppid', 'uid', 'start'].every(key => a[key] === b[key]);
const digest = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const nativeInspect = pid => {
  // Only the PID returned by our ChildProcess handle (or the verified owner's
  // retained helper) is queried here. No broad census, signals or guessed PID.
  const options = { encoding: 'utf8', timeout: 1000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } };
  const identity = childProcess.execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart=,comm='], options);
  const args = childProcess.execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=,args='], options);
  const rows = parseProcesses(identity, args);
  if (rows.length !== 1 || rows[0].pid !== pid) throw new Error('Owned subprocess identity unavailable');
  return rows[0];
};
function helperArguments(record, resume) {
  const state = JSON.parse(fs.readFileSync(join(record.root, 'maintenance-stage.json'), 'utf8'));
  const p = state.pending;
  if (p?.root !== record.root || p?.target !== record.target || p?.token !== record.token || state.dataDir !== record.dataDir
    || !/^[A-Za-z0-9 ._-]+$/.test(p.executable || '')) throw new Error('Helper handoff record changed');
  return [join(record.root, 'swap.sh'), '', record.target, join(record.root, 'Botling 2.app'), join(record.root, 'previous.app'), join(record.root, 'boot.ok'), record.token, p.executable, '0', '0.1', record.dataDir, resume ? '0' : '1200', '50'];
}
/** Trust is granted only to ChildProcess handles created inside an explicit
 * approved runtime operation. Exact argv, parent, uid and OS start identity are
 * registered before the gate releases; name/ancestry alone grants nothing.
 */
export function createProcessOwnership({ inspect = nativeInspect } = {}) {
  const context = new AsyncLocalStorage(), records = new Map();
  let installed = false, originals, censusId = 0;
  let resolvedLipo;
  const executable = (file, options) => {
    if (file !== '/usr/bin/lipo') return file;
    if (!resolvedLipo) {
      // /usr/bin/lipo is an Xcode shim on macOS. Resolve its concrete image
      // before spawn instead of accepting arbitrary post-exec path aliases.
      const selected = childProcess.execFileSync('/usr/bin/xcrun', ['--find', 'lipo'], { encoding: 'utf8', timeout: 3000, maxBuffer: 16384, env: options.env ?? process.env }).trim();
      if (!selected.startsWith('/') || /[\r\n\0]/.test(selected)) throw new Error('Concrete lipo executable unavailable');
      resolvedLipo = fs.realpathSync(selected);
      if (!fs.statSync(resolvedLipo).isFile()) throw new Error('Invalid concrete lipo executable');
      fs.accessSync(resolvedLipo, fs.constants.X_OK);
    }
    return resolvedLipo;
  };
  const scans = new Set(), waiting = new Set();
  const register = (child, file, args, gateArgs, scope) => {
    child.once('error', () => {});
    try {
      if (!Number.isSafeInteger(child.pid) || child.pid < 2) throw new Error('Owned subprocess failed to spawn');
      let identity = inspect(child.pid);
      const deadline = Date.now() + 1000;
      for (let attempt = 0; attempt < 3 && identity.executable === '(sh)' && Date.now() < deadline; attempt++) {
        // Darwin may briefly expose only the newborn process name. The gate is
        // still closed; never accept that placeholder as an executable identity.
        if (identity.ppid !== process.pid || identity.uid !== process.getuid() || identity.args !== ['/bin/sh', ...gateArgs].join(' ')) break;
        identity = inspect(child.pid);
      }
      const mismatch = [identity.ppid !== process.pid && 'parent', identity.uid !== process.getuid() && 'uid', identity.executable !== '/bin/sh' && 'executable', identity.args !== ['/bin/sh', ...gateArgs].join(' ') && 'argv'].filter(Boolean);
      if (mismatch.length) throw new Error('Owned subprocess attestation mismatch: ' + mismatch.join(','));
      const record = { identity, file, args: [...args], gate: identity.args, exited: false, helper: scope.helper ?? null, registeredAt: Date.now() };
      if (scope.helper) record.scriptDigest = digest(args[0]);
      records.set(child.pid, record);
      child.once('exit', () => { record.exited = true; waiting.delete(record); });
      child.stdin.on('error', () => {});
      record.release = accepted => { if (!record.exited) child.stdin.end(accepted ? 'go\n' : undefined); waiting.delete(record); };
      // Registration is visible before this JS turn yields. A running census
      // may observe the gate; release waits for all active censuses to accept.
      if (scans.size) waiting.add(record); else record.release(true);
    } catch (error) {
      child.stdin?.end(); // bounded gate exits without running the command
      throw error;
    }
    return child;
  };
  const validateScope = (file, args, scope) => {
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || /[\r\n\0]/.test(arg))) throw new Error('Unsupported owned argv');
    if (scope.helper && file === '/bin/sh') {
      if (JSON.stringify(args) !== JSON.stringify(helperArguments(scope.helper.record, scope.helper.resume))) throw new Error('Unexpected transaction helper invocation');
      return scope;
    }
    return { operation: scope.operation }; // verification subprocess, no helper authority
  };
  return {
    run(operation, callback) { return context.run({ operation }, callback); },
    withHelper(record, resume, callback) {
      const previousPid = resume ? Number(fs.readFileSync(join(record.root, 'helper.pid'), 'utf8')) : null;
      return context.run({ operation: 'helper-handoff', helper: { record, resume, previousPid } }, callback);
    },
    beginCensus() {
      const id = ++censusId; scans.add(id);
      return accepted => {
        if (!accepted) for (const r of waiting) r.blocked = true;
        scans.delete(id);
        if (!scans.size) for (const r of [...waiting]) r.release(!r.blocked);
      };
    },
    reconcileExited(row) {
      const r = records.get(row.pid);
      if (!r || !sameIdentity(row, r.identity) || (!r.exited && row.executable !== '<defunct>')) return null;
      if (row.executable === '<defunct>') return [r.file, ...r.args].join(' ');
      if (row.executable === r.file) return [r.file, ...r.args].join(' ');
      if (row.executable === '/bin/sh') return r.gate;
      return null;
    },
    install() {
      if (installed) throw new Error('Process ownership already installed');
      originals = { spawn: childProcess.spawn, execFile: childProcess.execFile };
      childProcess.spawn = function(file, args = [], options = {}) {
        const scope = context.getStore();
        if (!scope) return originals.spawn(file, args, options);
        const authority = validateScope(file, args, scope);
        if (options.stdio && options.stdio !== 'ignore') throw new Error('Unsupported owned helper stdio');
        const gateArgs = ['-p', '-c', GATE, 'botling-owned', file, ...args];
        const child = originals.spawn('/bin/sh', gateArgs, { ...options, stdio: ['pipe', 'ignore', 'ignore'] });
        return register(child, file, args, gateArgs, authority);
      };
      const trackedExecFile = function(file, args = [], options = {}, callback) {
        const scope = context.getStore();
        if (!scope) return originals.execFile(file, args, options, callback);
        file = executable(file, options);
        const authority = validateScope(file, args, scope), gateArgs = ['-p', '-c', GATE, 'botling-owned', file, ...args];
        const child = originals.execFile('/bin/sh', gateArgs, options, callback);
        return register(child, file, args, gateArgs, authority);
      };
      trackedExecFile[promisify.custom] = (file, args, options) => {
        let child;
        const result = new Promise((resolve, reject) => {
          child = trackedExecFile(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
        });
        result.child = child; return result;
      };
      childProcess.execFile = trackedExecFile;
      syncBuiltinESMExports(); installed = true;
    },
    restore() { if (installed) { Object.assign(childProcess, originals); syncBuiltinESMExports(); installed = false; } },
    attestObservations(...snapshots) {
      const allowed = [];
      for (const row of snapshots.flat()) {
        const r = records.get(row.pid);
        if (!r || !sameIdentity(row, r.identity)) continue;
        const gate = row.executable === '/bin/sh' && row.args === r.gate;
        const target = [r.file, '/bin/sh'].includes(row.executable) && row.args === [r.file, ...r.args].join(' '); // split ps observation during the one authorized exec transition
        const retired = row.executable === '<defunct>'; // OS-reported zombie of this exact attested child
        if (gate || target || retired) {
          if (r.helper && digest(r.args[0]) !== r.scriptDigest) throw new Error('Owned helper script changed');
          allowed.push(row);
        }
      }
      return allowed;
    },
    helperFor(record, publishedPid) {
      let r = [...records.values()].reverse().find(value => value.helper?.record.root === record.root && !value.exited);
      if (!r && publishedPid) {
        let identity;
        try { identity = inspect(publishedPid); }
        catch (error) {
          if (error.status === 1 && !String(error.stdout ?? '').trim() && !String(error.stderr ?? '').trim()) return null;
          throw error;
        }
        const args = [helperArguments(record, false), helperArguments(record, true)].find(argv => identity.args === ['/bin/sh', ...argv].join(' '));
        if (!args || identity.executable !== '/bin/sh' || identity.uid !== process.getuid() || ![1, process.pid].includes(identity.ppid)) throw new Error('Published helper identity mismatch');
        r = { identity, file: '/bin/sh', args, gate: null, helper: { record }, scriptDigest: digest(args[0]) };
        records.set(publishedPid, r);
      }
      if (!r) return null;
      if (publishedPid === r.identity.pid) r.published = true;
      else if (publishedPid) {
        if (!r.helper?.resume || r.published || publishedPid !== r.helper.previousPid || Date.now() - r.registeredAt > 5000) throw new Error('Helper publication differs from owned spawn');
      } else if (Date.now() - r.registeredAt > 5000 && !r.published) throw new Error('Owned helper publication timed out');
      return { pid: r.identity.pid, identity: r.identity, args: ['/bin/sh', ...r.args].join(' '), script: r.args[0] };
    },
  };
}
