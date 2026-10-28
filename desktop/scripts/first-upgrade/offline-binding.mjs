import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { persistentDigest, verifySnapshot } from './offline-snapshot.mjs';

// Thin binding to the owner's offline extension of VerifiedInstaller.
// No shell templates, snapshot copying, swapping or rollback implementation.
export function createOfflineBinding(runtime, plan, environment) {
  for (const name of ['beginMaintenance', 'readMaintenance', 'requireMaintenance', 'maintenancePhase', 'permitMaintenance', 'resumeMaintenance', 'durableJSON', 'invalidateMaintenance']) {
    if (typeof runtime[name] !== 'function') throw new Error(`Reviewed runtime missing offline export: ${name}`);
  }
  if (!Array.isArray(runtime.UPDATE_RECORDS)) throw new Error('Reviewed snapshot exclusion policy missing');
  let record = runtime.readMaintenance(plan.dataDir, plan.appPath);
  const requirePlan = r => {
    runtime.requireMaintenance(r);
    if (r.planSha256 !== plan.planSha256 || r.target !== plan.appPath || r.dataDir !== plan.dataDir) throw new Error('Maintenance belongs to another plan');
    return r;
  };
  const invalidated = async () => {
    if (record && !['committed', 'rolled-back'].includes(runtime.maintenancePhase(record))) { requirePlan(record); await runtime.invalidateMaintenance(record); }
  };
  const waitPhase = async (r, wanted, check, budget = 10 * 60_000) => {
    const until = Date.now() + budget;
    while (Date.now() < until) {
      requirePlan(r);
      const phase = runtime.maintenancePhase(r);
      if (phase === 'recovery-required') throw new Error('Offline transaction requires recovery; retained');
      await check();
      if (phase === wanted) return;
      await delay(250);
    }
    throw new Error(`Maintenance timed out waiting for ${wanted}; retained`);
  };
  const wrap = r => ({
    record: r,
    async stage(installer, authenticated, check) {
      requirePlan(r); await check();
      await installer.stageLocal(authenticated.zip, authenticated.version);
      await check();
      await installer.startMaintenance(check, environment);
      // The helper publishes its PID before any permit-controlled snapshot.
      // Do not misclassify our just-spawned helper during that publication gap.
      const until = Date.now() + 5000;
      while (!fs.existsSync(join(r.root, 'helper.pid'))) {
        if (Date.now() > until) throw new Error('Helper identity was not published; retained');
        await delay(20);
      }
    },
    async activateAwaitingOperator(check) {
      await waitPhase(r, 'awaiting-snapshot', check);
      const before = await persistentDigest(r.dataDir, runtime.UPDATE_RECORDS);
      await runtime.permitMaintenance(r, 'snapshot', check);
      await waitPhase(r, 'awaiting-activation', check);
      await verifySnapshot(r, before, runtime.UPDATE_RECORDS);
      await check();
      await runtime.permitMaintenance(r, 'activate', check);
      await waitPhase(r, 'activated-awaiting-operator-launch', check);
      // These digests bind operator resumption to this exact verified snapshot.
      await runtime.durableJSON(join(r.root, 'bootstrap-snapshot.json'), { planSha256: plan.planSha256, digest: before }, fs);
      return { state: 'awaiting-operator', transactionId: r.token, root: r.root };
    },
    recordFailure: invalidated,
    async launch(check) {
      const evidence = JSON.parse(await fsp.readFile(join(r.root, 'bootstrap-snapshot.json'), 'utf8'));
      if (evidence.planSha256 !== plan.planSha256) throw new Error('Snapshot plan changed');
      await verifySnapshot(r, evidence.digest, runtime.UPDATE_RECORDS);
      await runtime.permitMaintenance(r, 'launch', check);
      return { state: 'launch-authorized', transactionId: r.token, installed: false };
    },
    async rollback(check) {
      await runtime.permitMaintenance(r, 'rollback', check);
      return { state: 'rollback-authorized', transactionId: r.token, installed: false };
    },
  });
  return {
    helper() {
      if (!record || ['committed', 'rolled-back'].includes(runtime.maintenancePhase(record))) return null;
      requirePlan(record);
      try {
        const path = join(record.root, 'helper.pid'), st = fs.lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 32 || st.uid !== process.getuid()) throw new Error('Unsafe helper identity file');
        const pid = Number(fs.readFileSync(path, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Invalid helper PID');
        const state = runtime.maintenancePhase(record);
        let candidate;
        if (state === 'launching') {
          const staged = JSON.parse(fs.readFileSync(join(record.root, 'maintenance-stage.json'), 'utf8'));
          const executable = staged.pending?.executable;
          if (!/^[A-Za-z0-9 ._-]+$/.test(executable || '')) throw new Error('Unsafe candidate executable identity');
          candidate = { executable: join(record.target, 'Contents/MacOS', executable), appPath: record.target, token: record.token };
        }
        return { pid, script: join(record.root, 'swap.sh'), candidate };
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async acquire({ identities, assertQuiescent }) {
      record = await runtime.beginMaintenance({ target: plan.appPath, dataDir: plan.dataDir, planSha256: plan.planSha256 }, assertQuiescent);
      requirePlan(record);
      if (record.appIdentity !== identities.appIdentity || record.dataIdentity !== identities.profileIdentity) { await invalidated(); throw new Error('Filesystem identity changed at acquisition'); }
      return wrap(record);
    },
    async resume({ transactionId, assertQuiescent }) {
      record = runtime.readMaintenance(plan.dataDir, plan.appPath);
      if (!record || requirePlan(record).token !== transactionId) throw new Error('Transaction not found for approved plan');
      if (runtime.maintenancePhase(record) !== 'activated-awaiting-operator-launch') throw new Error('Transaction is not awaiting operator; explicit recovery required');
      // A dead helper can be restarted only by the owner's validated resume API.
      // Runtime decides liveness, integrity and permissible interrupted state.
      if (!this.helper()) throw new Error('Missing helper identity; explicit recovery required');
      const observation = await assertQuiescent();
      if (observation?.helperPresent !== true) {
        const oldPid = this.helper()?.pid;
        await runtime.resumeMaintenance(record, assertQuiescent, environment);
        const until = Date.now() + 5000;
        while (this.helper()?.pid === oldPid) {
          if (Date.now() > until) throw new Error('Resumed helper identity was not published; retained');
          await delay(20);
        }
        await waitPhase(record, 'activated-awaiting-operator-launch', assertQuiescent);
      }
      return wrap(record);
    },
    invalidate: invalidated,
    status(transactionId) {
      if (transactionId && !/^[a-f0-9-]{36}$/.test(transactionId)) throw new Error('Invalid transaction identity');
      if (transactionId && (!record || record.token !== transactionId)) {
        const matches = [];
        for (const name of fs.readdirSync(dirname(plan.appPath))) {
          if (!name.startsWith('.botling-update-')) continue;
          const root = join(dirname(plan.appPath), name), file = join(root, 'maintenance-owner.json');
          if (!fs.existsSync(file)) continue;
          const st = fs.lstatSync(file);
          if (!st.isFile() || st.isSymbolicLink() || st.size > 16384 || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('Unsafe maintenance history');
          const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (saved.token === transactionId && saved.planSha256 === plan.planSha256 && saved.target === plan.appPath && saved.dataDir === plan.dataDir && saved.root === root) {
            runtime.maintenancePhase(saved); matches.push(saved);
          }
        }
        if (matches.length !== 1) throw new Error('Transaction history missing or ambiguous');
        record = matches[0];
      }
      if (record) { const terminal = runtime.maintenancePhase(record); if (['committed', 'rolled-back'].includes(terminal)) return { transactionId: record.token, state: terminal, root: record.root }; }
      const r = runtime.readMaintenance(plan.dataDir, plan.appPath);
      return r ? { transactionId: requirePlan(r).token, state: runtime.maintenancePhase(r), root: r.root } : { state: 'no-active-maintenance' };
    },
    async removeAuthenticationScratch(authenticated) {
      // Authentication scratch is separate from maintenance staging; do not
      // remove transaction generations even on failure.
      const root = authenticated.root;
      if (dirname(root) !== dirname(plan.appPath) || !root.startsWith(join(dirname(plan.appPath), '.botling-hot-'))
        || await fsp.realpath(root) !== root || root === record?.root) throw new Error('Unsafe authentication cleanup root');
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}
