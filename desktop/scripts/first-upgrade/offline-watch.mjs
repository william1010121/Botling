import { setTimeout as delay } from 'node:timers/promises';
/** Serialize census requests and latch any uncertainty. Background observations
 * continue during authentication, staging and the operator's foreground pause.
 */
export function watchWindow(census, invalidate, interval = 250) {
  let running = false, pending, failure, stopped = false, signalFailure;
  const failed = new Promise(resolve => { signalFailure = resolve; });
  const check = async () => {
    if (failure) throw failure;
    if (!pending) pending = Promise.resolve().then(census).catch(async error => {
      failure = error; signalFailure(error);
      try { await invalidate(); } catch { /* retain original uncertainty */ }
      throw error;
    }).finally(() => { pending = null; });
    return pending;
  };
  const task = (async () => {
    running = true;
    while (!stopped) {
      try { await check(); } catch { break; }
      await delay(interval);
    }
    running = false;
  })();
  return { check, failed, get failure() { return failure; }, get running() { return running; }, async stop() { stopped = true; await task; } };
}
