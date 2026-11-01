// Antigravity's app-managed workers (shared-core spec 4.2). Each worker is its own ACP process (an AgyAcpHead with
// `worker: true`). What is the engine's lives here, in `AgyAcpAdapter`: the head's config and process identities,
// ACP's items translated into WorkerEvents, process-group cleanup and crash recovery, and approvals answered only with
// the exact input they asked. Everything else (state, text, the end and its report, the approvals table, report
// checkpoints) is the shared WorkerCore's. `AgyWorkers` keeps the constructor and methods agy-acp.ts uses, over the
// member's core the bot injects (its worker ledger, importing <acpHome>/workers.json once); without one (tests), a core
// over <acpHome>/workers.json (AgyLegacyStore).
import {AGY_WORKER_POLICY} from '../prompts-agy';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import type {HeadHandlers} from './head';
import type {StreamItem} from './stream';
import type {CodexItem} from './codex';
import type {AgyConfig} from './agy';
import {groupAlive,processStartTime} from '../process/kill-tree';
import type {TerminateResult} from '../process/tree';
import {movedTaskError,type ProcessIdentity,type WorkerHost,type WorkerInfo,type WorkerOwner,type WorkerOwnerResult,type WorkerSendResult} from './workers';
import {AgyLegacyStore,WorkerCore,wireStatus,type HandoffRequest,type RecoverResult,type RunEnd,type RunHandle,type WorkerAdapter,type WorkerCoreFactory,type WorkerCoreOptions,type WorkerEvent,type WorkerLedgerRecord,type WorkerStore} from '../worker-core';

export interface AgyWorkerHead {
  start():void;send(text:string,uuid:string):void;
  answer(id:string,allow:boolean,input:Record<string,unknown>,message?:string):void;
  terminate(graceMs?:number):Promise<TerminateResult>;
}

const canonical=(v:any):string=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const CLEANUP_INCOMPLETE='Worker cleanup incomplete; task remains blocked.';
const CRASH_UNVERIFIED='Worker crash cleanup has not been verified; process registration is missing or an owned group may survive. Cancellation and continuation remain blocked.';
const BUSY='This ACP worker is busy or cleaning up; in-turn steering is unsupported.';

/** One run's head, and the approvals it asked (by ACP's request id, without its `acp:` prefix). */
interface AgyRun {handle:RunHandle;head?:AgyWorkerHead;approvals:Map<string,Record<string,unknown>>;sawText:boolean;ended:boolean}

/** Antigravity's WorkerAdapter: one ACP process per run, ended (and its process group checked) when the run ends. */
export class AgyAcpAdapter implements WorkerAdapter {
  readonly kind='agy-acp' as const;
  readonly engine='agy' as const;
  readonly steersRunning=false;
  private runs=new Map<string,AgyRun>();
  private startTime:(pid:number)=>string|null;
  /** `processStartTime`: a process's start time (identity); a replay maps its recorded processes. */
  constructor(private config:AgyConfig,private factory:(c:AgyConfig,h:HeadHandlers)=>AgyWorkerHead,options:{processStartTime?(pid:number):string|null}={}){
    if(!config.acpHome)throw new Error('Worker profile required.');
    this.startTime=options.processStartTime??processStartTime;
  }
  /** An Antigravity coordinator's workers run over ACP; agy-worker-router.ts decides which engines may. */
  prepare(request:HandoffRequest){
    const engine=request.args.engine??'agy';
    if(engine!=='agy'&&engine!=='codex')throw new Error('Unsupported worker engine; Claude is forbidden.');
    return {engine:engine as 'agy'|'codex'};
  }
  start(record:Readonly<WorkerLedgerRecord>,words:string,handle:RunHandle){
    const live:AgyRun={handle,approvals:new Map(),sawText:false,ended:false};
    this.runs.set(record.id,live);
    const current=()=>this.runs.get(record.id)===live&&!live.ended;
    const end=(end:RunEnd)=>{if(!current())return;live.ended=true;live.approvals.clear();handle.emit({type:'end',end});};
    const config:AgyConfig={...this.config,worker:true,workerEngine:record.engine==='codex'?'codex':'agy',processStarted:pid=>{
      // A process the app cannot identify could outlive it unseen: refused (the head then stops it).
      if(!current())throw Error('Stale worker process registration.');
      const started=this.startTime(pid);if(!started)throw Error('Cannot record worker process identity.');
      this.config.processStarted?.(pid);handle.emit({type:'process',pid,started});
    },acpHome:join(this.config.acpHome!,'workers',record.id),sessionId:record.conversationId||randomUUID(),resume:!!record.conversationId,systemPrompt:`${this.config.workerInstructions??''}\n${AGY_WORKER_POLICY}`};
    try{
      live.head=this.factory(config,{onItem:item=>{if(current())this.item(record,live,item,end);},
        onExit:e=>end({how:e.expected?'cancelled':'exited',finalText:null,error:e.stderr||'ACP worker exited before a result.',detail:'exit'})});
      live.head.start();live.head.send(words,randomUUID());
    }catch(error){
      live.ended=true;void live.head?.terminate().catch(()=>undefined);
      throw error;
    }
  }
  /** ACP's items as WorkerEvents (`current` checked). */
  private item(record:Readonly<WorkerLedgerRecord>,live:AgyRun,item:StreamItem,end:(end:RunEnd)=>void){
    const emit=(event:WorkerEvent)=>live.handle.emit(event);
    switch(item.kind){
      case 'init':
        // A resumed worker must come back in its own conversation.
        if(record.conversationId&&record.conversationId!==item.sessionId)return end({how:'error',finalText:null,error:'Worker changed its saved conversation identity.',detail:'init'});
        return emit({type:'session',conversationId:item.sessionId});
      case 'delta':live.sawText=true;return emit({type:'textDelta',text:item.text});
      case 'textBlock':return emit({type:'textBreak'});
      case 'toolUse':return emit({type:'toolUse',id:item.id,tool:item.tool,title:item.title,detail:item.detail,input:item.input});
      case 'toolResult':return emit({type:'toolResult',id:item.id,output:item.output,failed:item.failed});
      case 'usage':return emit({type:'usage',tokens:item.tokens,cost:item.totalCost});
      case 'request':{const {scope:_scope,...request}=item.request;return emit({type:'request',request});}
      case 'permission':{
        const nativeId=item.requestId.replace(/^acp:/,'');
        live.approvals.set(nativeId,structuredClone(item.input));
        return emit({type:'permission',nativeId,tool:item.tool,summary:item.summary,input:item.input});
      }
      case 'permissionCancelled':{const nativeId=item.requestId.replace(/^acp:/,'');live.approvals.delete(nativeId);return emit({type:'permissionCancelled',nativeId});}
      case 'result':{
        // The report is the run's last text block (decision D1); a head that gave its words only here gets them as one block.
        if(!live.sawText&&item.text.trim())emit({type:'textWhole',text:item.text,phase:null});
        const how=item.how??(item.ok?'normal':'error');
        return end({how,finalText:null,error:how==='normal'?null:item.error||null,detail:item.subtype});
      }
    }
  }
  /** Whether `input` is exactly what this run's approval `nativeId` asked: an answer for other input is not its answer. */
  asks(id:string,run:number,nativeId:string,input:Record<string,unknown>):boolean {
    const live=this.runs.get(id),original=live?.approvals.get(nativeId);
    return !!live&&!!original&&!live.ended&&live.handle.run===run&&canonical(original)===canonical(input);
  }
  answer(record:Readonly<WorkerLedgerRecord>,nativeId:string,allow:boolean,input:Record<string,unknown>,message?:string){
    const live=this.runs.get(record.id),original=live?.approvals.get(nativeId);
    if(!live||!original||live.ended)return;
    live.approvals.delete(nativeId);
    // Always with the input it asked; an answer that came with other input refuses it.
    live.head?.answer(`acp:${nativeId}`,allow&&canonical(original)===canonical(input),original,message);
  }
  async stop(record:Readonly<WorkerLedgerRecord>){
    const live=this.runs.get(record.id);
    if(live){live.ended=true;live.approvals.clear();}
    return {cleaned:await this.terminate(record)};
  }
  /** Its run ended: its process group is ended and checked before the report goes out. */
  async cleanup(record:Readonly<WorkerLedgerRecord>){return {cleaned:await this.terminate(record)};}
  /** Ends the head (kept when that fails, to try again) and checks its recorded processes are gone. */
  private async terminate(record:Readonly<WorkerLedgerRecord>):Promise<boolean> {
    const live=this.runs.get(record.id);
    // Gone only when the process layer confirms its tree ended and no recorded process lives on.
    let ended:TerminateResult|undefined;
    try{ended=await live?.head?.terminate();}catch{return false;}
    if(ended?.alive)return false;
    if(record.processes.length&&!this.gone(record.processes))return false;
    if(live)live.head=undefined;
    return true;
  }
  /**
   * After an interruption or a failed cleanup. A head this app still holds is ended again; otherwise only proof that
   * every recorded process is gone releases it (none recorded is never assumed clean).
   */
  recover(record:Readonly<WorkerLedgerRecord>):RecoverResult|Promise<RecoverResult>{
    const blocked=():RecoverResult=>({state:'blocked',reason:record.cleanup==='failed'?CLEANUP_INCOMPLETE:CRASH_UNVERIFIED});
    if(this.runs.get(record.id)?.head)return this.terminate(record).then(cleaned=>cleaned?{state:'clean'}:blocked());
    return this.gone(record.processes)?{state:'clean'}:blocked();
  }
  private gone(processes:readonly ProcessIdentity[]):boolean {
    if(!processes.length)return false;
    return processes.every(({pid,started})=>{
      const current=this.startTime(pid);
      // The same process still runs, or another took its pid (the old group cannot coexist with a reused leader pid).
      if(current)return current!==started;
      return !groupAlive(pid);
    });
  }
  /** Whether it still holds a head of this worker that it could not end. */
  holds(id:string):boolean {return !!this.runs.get(id)?.head&&!!this.runs.get(id)?.ended;}
  runtime(){return {reasoningEffort:this.config.effort??null};}
  async close(){
    const results=await Promise.allSettled([...this.runs.values()].map(async live=>{live.ended=true;await live.head?.terminate();live.head=undefined;}));
    if(results.some(r=>r.status==='rejected'))throw new Error(CLEANUP_INCOMPLETE);
  }
}

/**
 * The Antigravity coordinator's workers: a WorkerCore with the ACP adapter, reports handed to the head's queue
 * (`report`, checkpoint policy: the head calls beginReport / finishReport around the turn that shows one).
 * Dormant until live validation (agy-capabilities.ts). No production gate is lifted by it.
 */
export class AgyWorkers {
  private core:WorkerCore;
  private adapter:AgyAcpAdapter;
  /** `core`: the member's (the bot's worker ledger and projections), which lists only this conversation's workers. */
  constructor(config:AgyConfig,emit:(i:CodexItem)=>void,report:(id:string,text:string,run:number)=>void,factory:(c:AgyConfig,h:HeadHandlers)=>AgyWorkerHead,core?:WorkerCoreFactory){
    this.adapter=new AgyAcpAdapter(config,factory);
    const acpHome=config.acpHome!;
    // ACP names a new conversation at its start (config.sessionId changes once): the journal always carries the current one.
    const store:WorkerStore={
      load:()=>new AgyLegacyStore(acpHome,config.sessionId,{resume:!!config.resume}).load(),
      save:records=>new AgyLegacyStore(acpHome,config.sessionId).save(records),
    };
    const options:WorkerCoreOptions={store,sink:{item:emit},adapters:[this.adapter],ownerSessionId:()=>config.sessionId,pendingSignal:true,log:()=>undefined,
      port:{ack:'checkpoint',deliver:(r,text)=>{report(r.id,text,r.run);return 'queued';}}};
    this.core=core?.({...options,sessionScoped:true},{agy:{acpHome,sessionId:config.sessionId}})??new WorkerCore(options);
    this.core.redeliver();
  }
  get hostedLive(){return this.core.hostedLive;}
  get completionDependencies(){return this.core.completionDependencies;}
  /** Workers whose processes are at work, being cleaned up, or failed to be. */
  get running(){return this.core.all().filter(r=>r.status==='running'||r.cleanup).map(r=>r.id);}
  /** Its workers, provider-neutral (workers.ts). */
  list():WorkerInfo[]{return this.core.listWorkers();}
  /** A follow-up from the app (workers.ts `sendToWorker`): an idle worker's next run; a busy ACP worker takes no steering. */
  continueTask(id:string,text:string){return this.core.sendToWorker(id,text);}
  /** Stops one worker and its tools (the sub-bot hand-off: a busy ACP worker cannot be messaged). False: no such worker, or not at work. */
  async cancelTask(id:string):Promise<boolean>{
    if(!await this.core.stopWorker(id))return false;
    if(this.core.get(id)?.cleanup==='failed')throw new Error(CLEANUP_INCOMPLETE);
    return true;
  }
  /** workers.ts `setWorkerOwner`. */
  setOwner(id:string,owner:WorkerOwner|null):WorkerOwnerResult{return this.core.setWorkerOwner(id,owner);}
  /** The coordinator's app tools (agy-mcp.ts). A call on an existing task names its engine (if at all) and current run. */
  async tool(name:string,args:Record<string,unknown>):Promise<any>{
    if(name==='app_handoff')return this.core.handoff('agy-acp',args);
    const r=this.core.get(String(args.task_id));if(!r)throw new Error('Unknown task_id.');
    if(r.owner)throw new Error(movedTaskError(r.owner.name));
    if(args.engine!==undefined&&args.engine!==r.engine)throw new Error('Worker engine identity cannot change on continuation.');
    if(args.run!==r.run)throw new Error('Stale or missing worker run identity.');
    switch(name){
      case 'app_reconcile_report':return this.core.reconcile(args);
      case 'app_task_checkpoint':return this.core.checkpoint(args);
      case 'app_cancel_task':{const {status}=await this.core.cancel(r.id,r.run);return {task_id:r.id,run:r.run,status:status==='done'?wireStatus(status):status};}
      case 'app_send_message':{
        if(r.status==='running'||r.cleanup==='pending')throw new Error(BUSY);
        const sent=await this.core.message(args);return {accepted:true,task_id:sent.task_id,run:sent.run};
      }
    }
    throw new Error('Unsupported worker tool.');
  }
  beginReport(id:string,run:number):boolean{return this.core.beginReport(id,run);}
  /** Delivery is not acceptance: a report turn that made no decision shows the report once more, then leaves it unresolved. */
  finishReport(id:string,run:number,completed:boolean){this.core.finishReport(id,run,completed);}
  /** An approval card's answer. One whose input is not exactly what was asked is not this approval's: its card stays. */
  answer(id:string,allow:boolean,input:Record<string,unknown>,message?:string):boolean{
    const match=/^worker:([^:]+):(\d+):(.+)$/.exec(id);
    return !!match&&this.adapter.asks(match[1]!,Number(match[2]),match[3]!,input)&&this.core.answer(id,allow,input,message);
  }
  /** Stops every worker at work and ends failed cleanups again; throws while one's processes may still be alive. */
  async cancel(){
    await Promise.allSettled(this.core.all().map(r=>r.status==='running'?this.core.stopWorker(r.id):r.cleanup==='failed'?this.core.cancel(r.id):undefined));
    if(this.running.length)throw new Error('Worker cleanup incomplete; live or recovery dependencies retained.');
  }
  /**
   * The app is quitting: runs under way are interrupted (never replayed). Throws when a worker's processes may outlive
   * it (a crash this app could not verify, a cleanup that failed): the head reports its cleanup incomplete.
   */
  async close(){
    const unverified=new Set(this.core.all().filter(r=>r.recovery==='required'||r.cleanup==='failed').map(r=>r.id));
    await this.core.close();
    // Runs it ended just now are checked at the next start; here, whatever was unverified already or could not be ended.
    const checks=await Promise.all(this.core.all().filter(r=>unverified.has(r.id)||this.adapter.holds(r.id)).map(r=>this.adapter.recover(r)));
    if(checks.some(c=>c.state==='blocked'))throw new Error('Worker cleanup incomplete; live or recovery dependencies retained.');
  }
}

/** Antigravity's workers as a WorkerHost (workers.ts). A busy ACP worker takes no words until it reports. */
export function agyWorkerHost(workers:()=>AgyWorkers|undefined):WorkerHost{
  return {
    workerHostKind:'agy-acp',steersRunning:false,
    listWorkers:()=>workers()?.list()??[],
    sendToWorker:(id,text):WorkerSendResult|Promise<WorkerSendResult>=>workers()?.continueTask(id,text)??{ok:false,reason:'This Antigravity head has no workers.'},
    stopWorker:async id=>(await workers()?.cancelTask(id))??false,
    setWorkerOwner:(id,owner)=>workers()?.setOwner(id,owner)??{ok:false,reason:'This Antigravity head has no workers.'},
    answer:(id,allow,input,message)=>workers()?.answer(id,allow,input,message)??false,
    close:async()=>{await workers()?.close();},
  };
}
