import {join} from 'node:path';
import type {AgyConfig} from './agy';
import type {HeadHandlers} from './head';
import type {AgyWorkerHead} from './agy-workers';
import {AgyCodexHead} from './agy-codex-head';
import {CodexThreads,type CodexHeadConfig} from './codex';
import {agyMixedRuntimeEnabled,agyWorkerRuntimeEnabled} from './agy-capabilities';

/** App-only config normalization. Native inventory and existing-account behavior still need live validation. */
export function codexWorkerConfig(config:AgyConfig):CodexHeadConfig {
  if(!config.acpHome||!config.codexWorkerConfig)throw Error('App-owned Codex worker transport/profile unavailable.');
  const base=config.codexWorkerConfig(config);
  const threads=new CodexThreads(join(config.acpHome,'codex'));
  if(config.resume&&!threads.thread(config.sessionId))throw Error('Codex worker conversation mapping missing; no replacement session or replay.');
  return {...base,cwd:config.cwd,sessionId:config.sessionId,resume:config.resume,threads,
    instructions:config.systemPrompt??'',workerInstructions:null,componentEditor:null,routinesFile:null,
    autoMode:false,bypassPermissions:false,writableRoots:[],retryLog:null};
}

/** The factory is wired but unreachable in production while the source gate remains false. */
export function createAgyWorkerHead(config:AgyConfig,handlers:HeadHandlers,agy:(c:AgyConfig,h:HeadHandlers)=>AgyWorkerHead):AgyWorkerHead {
  if(!agyWorkerRuntimeEnabled())throw Error('App-managed engine workers are disabled pending live validation.');
  const engine=config.workerEngine??'agy';
  if(engine==='agy')return agy(config,handlers);
  if(engine!=='codex'||!agyMixedRuntimeEnabled())throw Error('Unsupported cross-engine worker; Claude is forbidden.');
  const safe=codexWorkerConfig(config);
  const head=new AgyCodexHead(safe,{onExit:handlers.onExit,onItem:item=>{
    // Preserve the existing event shape; no usage/identity redesign in this adapter.
    if(item.kind==='init'||item.kind==='usage'||item.kind==='result'||item.kind==='permission'||item.kind==='permissionCancelled'||item.kind==='delta'||item.kind==='toolUse'||item.kind==='toolResult')handlers.onItem(item);
  }});
  return {
    start(){head.start();try{if(head.pid<=0)throw Error('Codex worker did not start.');config.processStarted?.(head.pid);}catch(error){void head.terminate();throw error;}},
    send(text,id){head.send(text,id);},
    answer(id,allow,input,message){head.answer(id,allow,input,message);},
    terminate(graceMs){return head.terminate(graceMs);},
  };
}
