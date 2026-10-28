#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { offlinePlan, approve, prepareOffline, operatorAction, loadReviewedRuntime, requireCleanEnvironment } from './offline-adapter.mjs';
import { createOfflineBinding } from './offline-binding.mjs';
import { createWriterCheck } from './offline-processes.mjs';
import { createProcessOwnership } from './process-ownership.mjs';
import { watchWindow } from './offline-watch.mjs';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const terminal = state => ['committed', 'rolled-back'].includes(state);
let watcher, input, ownership;
try {
  const [action, inputFile, trustFile, approvalFile, ...extra] = process.argv.slice(2);
  if (!['plan', 'prepare', 'status', 'launch', 'rollback'].includes(action) || !inputFile || !trustFile || extra.length) throw new Error('Usage: offline-cli.mjs plan|prepare|status|launch|rollback INPUT_OR_PLAN.json REVIEWED-release-config.json [ACTION-APPROVAL.json]');
  const plan = json(inputFile), key = json(trustFile).publicKey;
  if (action === 'plan') {
    if (approvalFile) throw new Error('Plan does not accept approval');
    console.log(JSON.stringify(offlinePlan(plan, key), null, 2));
  } else {
    requireCleanEnvironment(process.env);
    if (offlinePlan(plan, key).planSha256 !== plan.planSha256) throw new Error('Review a complete offline plan first');
    let approval;
    if (action !== 'status') { approval = json(approvalFile); approve(plan, key, approval, action); }
    // For read-only status, the fourth argument is an optional transaction UUID.
    ownership = createProcessOwnership(); ownership.install();
    const runtime = await loadReviewedRuntime(plan);
    const binding = createOfflineBinding(runtime, plan, process.env, ownership);
    if (action === 'status') console.log(JSON.stringify(binding.status(approvalFile), null, 2));
    else {
      const census = createWriterCheck({ ...plan, helper: () => binding.helper(), ownership });
      watcher = watchWindow(async () => {
        if (terminal(binding.status().state)) return { terminal: true };
        try { return await census(); }
        catch (error) { if (terminal(binding.status().state)) return { terminal: true }; throw error; }
      }, () => binding.invalidate());
      const check = watcher.check;
      if (action === 'prepare') {
        const paused = await ownership.run('approved-prepare', () => prepareOffline(plan, key, approval, binding, { runtime, check }));
        console.log(JSON.stringify(paused, null, 2));
        console.error('Keep this foreground monitor running. Do not relaunch old .18. Enter the path of a separately approved launch/rollback JSON file.');
        input = createInterface({ input: process.stdin, output: process.stderr });
        while (true) {
          const next = await Promise.race([input.question('Action approval file: '), watcher.failed.then(error => { throw error; })]);
          let choice;
          try {
            choice = json(next.trim());
            if (!['launch', 'rollback'].includes(choice.action)) throw new Error('Choose launch or rollback');
            approve(plan, key, choice, choice.action);
            if (choice.transactionId !== paused.transactionId) throw new Error('Approval names a different transaction');
          } catch (error) { console.error(error.message); continue; }
          console.log(JSON.stringify(await ownership.run('approved-operator-action', () => operatorAction(plan, key, choice, choice.action, paused.transactionId, binding, { check })), null, 2));
          break;
        }
        input.close(); input = null;
      } else {
        console.log(JSON.stringify(await ownership.run('approved-operator-action', () => operatorAction(plan, key, approval, action, approval.transactionId, binding, { check })), null, 2));
      }
      // Keep writer monitoring through candidate boot/rollback, not just until permit.
      while (true) {
        const status = binding.status();
        if (terminal(status.state)) { console.log(JSON.stringify(status, null, 2)); break; }
        if (status.state === 'recovery-required') throw new Error('Transaction retained for explicit recovery');
        await check(); await delay(250);
      }
    }
  }
} catch (error) {
  console.error(`Offline maintenance refused: ${error.message}`);
  process.exitCode = 1;
} finally {
  input?.close();
  if (watcher) await watcher.stop();
  ownership?.restore();
}
