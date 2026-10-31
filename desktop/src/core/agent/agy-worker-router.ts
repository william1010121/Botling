import type {AgyConfig} from './agy';
import type {HeadHandlers} from './head';
import type {AgyWorkerHead} from './agy-workers';
import {agyWorkerRuntimeEnabled} from './agy-capabilities';

/** Only Antigravity workers run; cross-engine (Codex) workers stay unsupported. */
export function createAgyWorkerHead(config:AgyConfig,handlers:HeadHandlers,agy:(c:AgyConfig,h:HeadHandlers)=>AgyWorkerHead):AgyWorkerHead {
  if(!agyWorkerRuntimeEnabled())throw Error('App-managed engine workers are disabled pending live validation.');
  if((config.workerEngine??'agy')!=='agy')throw Error('Unsupported cross-engine worker; Claude is forbidden.');
  return agy(config,handlers);
}
