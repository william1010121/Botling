import {AGY_WORKER_POLICY} from '../prompts-agy';
import {randomUUID} from 'node:crypto';
import {readFileSync,mkdirSync} from 'node:fs';
import {writeFileAtomic} from '../durable/atomic';
import {join} from 'node:path';
import type {HeadHandlers} from './head';
import type {StreamItem} from './stream';
import type {CodexItem} from './codex';
import type {AgyConfig} from './agy';
import {processStartTime} from '../process/ledger';
import type {TerminateResult} from '../process/tree';

export interface AgyWorkerHead {
  start():void;send(text:string,uuid:string):void;
  answer(id:string,allow:boolean,input:Record<string,unknown>,message?:string):void;
  terminate(graceMs?:number):Promise<TerminateResult>;
}
interface Worker {
  id:string;engine:"agy"|"codex";name:string;instructions:string;sessionId:string;run:number;active:boolean;
  cleaning:boolean;denied:boolean;recoveryRequired?:boolean;reportDispatching?:boolean;report?:string;status:string;reportPending:boolean;
  reportDelivered?:boolean; reviewAttempts?:number; checkpoint?:{outcome:string;evidence:string;dependency_task_id?:string};
  head?:AgyWorkerHead;cleanup?:Promise<void>;discardReport?:boolean;
  approvals:Map<string,Record<string,unknown>>;processes:{pid:number;started:string}[];
}
const canonical=(v:any):string=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Dormant until live validation. No production gate is lifted by this state machine. */
export class AgyWorkers {
  private workers=new Map<string,Worker>();
  private closed=false;
  private activeReports=new Map<string,number>();
  constructor(private config:AgyConfig,private emit:(i:CodexItem)=>void,private report:(id:string,text:string,run:number)=>void,private factory:(c:AgyConfig,h:HeadHandlers)=>AgyWorkerHead){
    if(!config.acpHome)throw new Error('Worker profile required.');
    if(!config.resume)return;
    try{
      const saved=JSON.parse(readFileSync(join(config.acpHome,'workers.json'),'utf8'));
      if(saved.version!==2||saved.ownerSessionId!==config.sessionId||!Array.isArray(saved.workers)||saved.workers.length>128)throw Error('Invalid worker owner');
      // Validate the complete state before any callback. Legacy/foreign state is preserved, never adopted.
      const restored:Worker[]=saved.workers.map((r:any)=>{
        if(!r||typeof r.id!=='string'||!uuid.test(r.id)||(r.engine!==undefined&&r.engine!=='agy'&&r.engine!=='codex')||typeof r.sessionId!=='string'||!Number.isSafeInteger(r.run)||r.run<1||typeof r.name!=='string'||typeof r.instructions!=='string'||typeof r.status!=='string'||typeof r.active!=='boolean'||typeof r.cleaning!=='boolean'||typeof r.reportPending!=='boolean'||(r.report!==undefined&&typeof r.report!=='string'))throw Error('Invalid worker state');
        if((r.reviewAttempts!==undefined&&(!Number.isSafeInteger(r.reviewAttempts)||r.reviewAttempts<0||r.reviewAttempts>2))||(r.reportDelivered!==undefined&&typeof r.reportDelivered!=='boolean'))throw Error('Invalid report review state');
        if(!Array.isArray(r.processes)||r.processes.some((p:any)=>!Number.isSafeInteger(p.pid)||p.pid<=0||typeof p.started!=='string'||!p.started))throw Error('Invalid process identity');
        return {id:r.id,engine:r.engine??"agy",name:r.name,instructions:r.instructions,sessionId:r.sessionId,run:r.run,active:false,cleaning:false,denied:false,approvals:new Map(),processes:r.processes,status:r.status,report:r.report,reportPending:r.reportPending,recoveryRequired:r.recoveryRequired===true||r.active||r.cleaning,reportDispatching:r.reportDispatching===true,reportDelivered:r.reportDelivered===true,reviewAttempts:r.reviewAttempts??0,checkpoint:r.checkpoint,
          ...(r.active||r.cleaning?{status:'stopped',report:'Worker interrupted before confirmed cleanup/result. Process-ledger recovery is required before any explicit continuation; no task was replayed.',reportPending:true}:{})};
      });
      if(new Set(restored.map(w=>w.id)).size!==restored.length)throw Error('Duplicate worker identity');
      for(const w of restored)this.workers.set(w.id,w);
      this.save();
      for(const w of restored)if(w.reportPending){
        if(w.reportDispatching)this.emit({kind:'subagentEnded',id:w.id,status:'failed',summary:'Worker report delivery is uncertain after restart. No report prompt was replayed; explicit reconciliation is required.'});
        else if((w.reviewAttempts??0)<2)this.deliverReport(w);
        else this.unresolved(w);
      }
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('ACP worker state is unreadable or belongs to another conversation; preserved for recovery.');}
  }
  get running(){return [...this.workers.values()].filter(w=>w.active||w.cleaning||w.cleanup||w.recoveryRequired).map(w=>w.id);}
  get completionDependencies(){return [...this.workers.values()].filter(w=>w.active||w.cleaning||w.cleanup||w.recoveryRequired||w.reportPending).map(w=>({id:w.id,run:w.run,task:w.instructions,state:w.active||w.cleaning||w.cleanup||w.recoveryRequired?'running' as const:'reportQueued' as const,callback:'app_task_result' as const,taskTruncated:false}));}
  private save(){mkdirSync(this.config.acpHome!,{recursive:true});writeFileAtomic(join(this.config.acpHome!,'workers.json'),JSON.stringify({version:2,ownerSessionId:this.config.sessionId,workers:[...this.workers.values()].map(({head,cleanup,approvals,discardReport,...w})=>w)}));}
  async tool(name:string,args:Record<string,unknown>){
    if(this.closed)throw new Error('Worker manager closed.');
    if(name==='app_handoff'){
      const engine=args.engine??'agy';if(engine!=='agy'&&engine!=='codex')throw new Error('Unsupported worker engine; Claude is forbidden.');
      if(typeof args.instructions!=='string'||!args.instructions.trim()||args.instructions.length>64_000)throw new Error('Instructions required (maximum 64000 characters).');
      if(this.running.length>=4)throw new Error('Four ACP workers are already running or cleaning up.');
      if(this.workers.size>=128)throw new Error('Worker history limit reached.');
      const id=randomUUID(),w:Worker={id,engine,name:typeof args.name==='string'?args.name.slice(0,200):args.instructions.slice(0,80),instructions:args.instructions,sessionId:'',run:0,active:false,cleaning:false,denied:false,approvals:new Map(),processes:[],status:'new',reportPending:false};this.workers.set(id,w);
      this.launch(w,args.instructions);return {accepted:true,task_id:id,run:w.run};
    }
    const w=this.workers.get(String(args.task_id));if(!w)throw new Error('Unknown task_id.');
    if(args.engine!==undefined&&args.engine!==w.engine)throw new Error('Worker engine identity cannot change on continuation.');
    if(args.run!==w.run)throw new Error('Stale or missing worker run identity.');
    if(name==='app_reconcile_report'){
      if(w.active||w.cleaning||!w.reportPending||!w.reportDispatching)throw new Error('No uncertain report available for reconciliation.');
      if(args.action!=='acknowledge'&&args.action!=='retry')throw new Error('Explicit report reconciliation action required.');
      if((this.activeReports.get(w.id)===w.run))throw new Error('Report turn is still active.');
      w.reportDispatching=false;w.reportDelivered=args.action==='acknowledge';w.reviewAttempts=args.action==='acknowledge'?2:0;this.save();
      if(args.action==='retry')this.deliverReport(w);
      return {task_id:w.id,run:w.run,action:args.action,taskReplayed:false};
    }
    if(name==='app_task_checkpoint'){
      if(w.active||w.cleaning||w.cleanup||!w.reportPending||(!(this.activeReports.get(w.id)===w.run)&&(!w.reportDelivered||w.reportDispatching)))throw new Error('No delivered report available for a checkpoint.');
      if(!['complete','waiting_user','waiting_dependency','blocked'].includes(String(args.outcome))||typeof args.evidence!=='string'||!args.evidence.trim()||args.evidence.length>16000)throw new Error('Checkpoint outcome and concrete evidence required.');
      if(args.outcome==='waiting_dependency'){
        const dependency=this.workers.get(String(args.dependency_task_id));
        if(!dependency||dependency===w||!dependency.active)throw new Error('Checkpoint needs another actively running dependency_task_id.');
      }else if(args.dependency_task_id!==undefined)throw new Error('dependency_task_id requires waiting_dependency.');
      w.checkpoint={outcome:String(args.outcome),evidence:args.evidence,...(args.outcome==='waiting_dependency'?{dependency_task_id:String(args.dependency_task_id)}:{})};
      w.reportPending=false;w.reportDispatching=false;this.activeReports.delete(w.id);this.save();
      return {task_id:w.id,run:w.run,...w.checkpoint};
    }
    if(name==='app_cancel_task'){await this.stop(w,true);if(w.cleaning)throw new Error('Worker cleanup incomplete; task remains blocked.');return {task_id:w.id,run:w.run,status:w.status};}
    if(name==='app_send_message'){
      this.verifyRecovery(w);
      if(w.active||w.cleaning||w.cleanup)throw new Error('This ACP worker is busy or cleaning up; in-turn steering is unsupported.');
      if(w.reportPending&&!(this.activeReports.get(w.id)===w.run)&&(!w.reportDelivered||w.reportDispatching))throw new Error('The prior worker report must be acknowledged before continuation.');
      if(this.running.length>=4)throw new Error('Four ACP workers are already running or cleaning up.');
      if(typeof args.message!=='string'||!args.message.trim()||args.message.length>64_000)throw new Error('Message required (maximum 64000 characters).');
      this.launch(w,args.message);return {accepted:true,task_id:w.id,run:w.run};
    }
    throw new Error('Unsupported worker tool.');
  }
  private launch(w:Worker,text:string){
    this.activeReports.delete(w.id);w.reportDelivered=false;w.reviewAttempts=0;delete w.checkpoint;
    w.processes=[];w.active=true;w.run++;const run=w.run;w.status='running';w.denied=false;w.discardReport=false;w.reportPending=false;w.reportDispatching=false;delete w.report;this.save();
    this.emit({kind:'managedPending',pending:true});
    this.emit({kind:'toolUse',id:w.id,tool:'Agent',title:`Delegate ${w.name}`,detail:text,parent:null,input:{description:w.name,prompt:text,subagent_type:`${w.engine}-worker`,run_in_background:true}});
    this.emit({kind:'subagentStarted',id:w.id,description:w.name,type:`${w.engine}-worker`,prompt:text,background:true,execution:{run,ownerSessionId:this.config.sessionId,threadId:w.sessionId||null,turnId:null}});
    this.emit({kind:'subagentRuntime',id:w.id,runtime:{engine:w.engine,reasoningEffort:this.config.effort}});
    const finish=(status:string,result:string)=>{
      if(!w.active||w.run!==run)return;
      if(w.denied||w.approvals.size){status='failed';result='Worker execution blocked by denied or unresolved approval.\n'+result;}
      w.active=false;w.reportPending=true;w.status=status;w.report=result.slice(0,200_000);this.cancelApprovals(w);
      void this.clean(w).then(()=>{
        if(w.run!==run)return;
        if(w.discardReport){w.status='stopped';w.reportPending=false;}else w.reportPending=true;
        this.save();this.emit({kind:'subagentEnded',id:w.id,status:w.status,summary:w.report??''});
        if(!this.closed&&w.reportPending)this.deliverReport(w);
      });
    };
    const onItem=(item:StreamItem)=>{
      if(this.closed||!w.active||w.run!==run)return;
      if(item.kind==='usage'){this.emit(item);return;}
      if(item.kind==='init'){
        if(w.sessionId&&w.sessionId!==item.sessionId){finish('failed','Worker changed its saved conversation identity.');return;}
        w.sessionId=item.sessionId;this.save();return;
      }
      if(item.kind==='result'){finish(item.ok&&item.text.trim()?'completed':'failed',item.text||item.error||'Worker ended without an evidence report.');return;}
      if(item.kind==='permission'){
        if(w.approvals.has(item.requestId)){finish('failed','Duplicate worker permission identity.');return;}
        w.approvals.set(item.requestId,JSON.parse(JSON.stringify(item.input)));
        this.emit({...item,requestId:`worker:${w.id}:${run}:${item.requestId}`,workerId:w.id});return;
      }
      if(item.kind==='permissionCancelled'){w.denied=true;if(w.approvals.delete(item.requestId))this.emit({...item,requestId:`worker:${w.id}:${run}:${item.requestId}`});return;}
      if(item.kind==='delta'){this.emit({kind:'subagentText',parent:w.id,text:item.text});return;}
      if(item.kind==='toolUse'||item.kind==='toolResult'){if(item.kind==='toolResult'&&item.failed)w.denied=true;this.emit({...item,parent:w.id,id:`${w.id}:${run}:${item.id}`});}
    };
    try{
      w.head=this.factory({...this.config,worker:true,workerEngine:w.engine,processStarted:pid=>{
        if(w.run!==run||!w.active)throw Error('Stale worker process registration.');
        const started=processStartTime(pid);if(!started)throw Error('Cannot record worker process identity.');
        this.config.processStarted?.(pid);w.processes.push({pid,started});this.save();
      },acpHome:join(this.config.acpHome!,'workers',w.id),sessionId:w.sessionId||randomUUID(),resume:!!w.sessionId,systemPrompt:`${this.config.workerInstructions??''}\n${AGY_WORKER_POLICY}`},{onItem,onExit:e=>{if(w.run===run&&w.active)finish(e.expected?'stopped':'failed',e.stderr||'ACP worker exited before a result.');}});
      w.head.start();w.head.send(text,randomUUID());
    }catch(error){finish('failed',(error as Error).message);}
  }
  private processesGone(w:Worker):boolean {
    if(!w.processes.length)return false; // crash before registration is ambiguous, never assumed clean.
    return w.processes.every(({pid,started})=>{
      const current=processStartTime(pid);
      if(current&&current!==started)return true; // old group cannot coexist with a reused leader PID.
      try{process.kill(-pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}
    });
  }
  /** Cleanup is a completion dependency and holds a concurrency slot; never release it on failure. */
  private clean(w:Worker):Promise<void>{
    if(w.cleanup)return w.cleanup;
    const head=w.head;w.cleaning=true;this.save();
    w.cleanup=Promise.resolve().then(()=>head?.terminate()).then(()=>{if(w.processes.length&&!this.processesGone(w))throw Error('Worker process group still exists.');w.cleaning=false;w.head=undefined;}).catch(()=>{w.status='cleanup-failed';w.report='Worker process cleanup failed. Explicit recovery is required; no continuation permitted.';}).finally(()=>{w.cleanup=undefined;this.save();});
    return w.cleanup;
  }
  private cancelApprovals(w:Worker){for(const id of w.approvals.keys())this.emit({kind:'permissionCancelled',requestId:`worker:${w.id}:${w.run}:${id}`});w.approvals.clear();}
  private deliverReport(w:Worker){
    this.report(w.id,`<app_task_result task_id="${w.id}" run="${w.run}" engine="${w.engine}" status="${w.status}">\n${(w.report??'').replaceAll('<','&lt;')}\n</app_task_result>\nWorker completion is execution evidence, not acceptance of the user's full objective. Resolve this exact task_id and run with app_task_checkpoint (outcome and concrete evidence) or same-task app_send_message before ending this report turn. Research-only scope and existing permissions remain unchanged.`,w.run);
  }
  beginReport(id:string,run:number):boolean {
    const w=this.workers.get(id);if(this.closed||!w||w.run!==run||!w.reportPending||w.reportDispatching||w.active||w.cleaning||w.cleanup||(w.reviewAttempts??0)>=2)return false;
    w.reportDispatching=true;this.activeReports.set(id,run);this.save();return true;
  }
  /** Delivery is not acceptance. A successful report turn must make a decision. */
  finishReport(id:string,run:number,completed:boolean){
    if(this.activeReports.get(id)!==run)return;
    this.activeReports.delete(id);
    const w=this.workers.get(id);if(this.closed||!w||w.run!==run||!w.reportPending)return;
    if(!completed)return; // uncertain delivery remains durable; never replay automatically
    w.reportDelivered=true;w.reportDispatching=false;w.reviewAttempts=(w.reviewAttempts??0)+1;this.save();
    if(w.reviewAttempts===1)this.deliverReport(w);
    else this.unresolved(w);
  }
  private unresolved(w:Worker){this.emit({kind:'subagentEnded',id:w.id,status:'failed',summary:'Worker report unresolved: no task/run checkpoint or same-task continuation after one reconciliation turn. Evidence retained; explicit decision required.'});}
  answer(id:string,allow:boolean,input:Record<string,unknown>,message?:string){
    const match=/^worker:([a-f0-9-]{36}):(\d+):(.+)$/.exec(id);if(!match||this.closed)return;
    const w=this.workers.get(match[1]!);if(!w?.active||w.run!==Number(match[2]))return;
    const original=w.approvals.get(match[3]!);if(!original||canonical(original)!==canonical(input))return;
    w.approvals.delete(match[3]!);if(!allow)w.denied=true;w.head?.answer(match[3]!,allow,original,message);
  }
  private verifyRecovery(w:Worker){
    if(!w.recoveryRequired)return;
    if(!this.processesGone(w))throw new Error('Worker crash cleanup has not been verified; process registration is missing or an owned group may survive. Cancellation and continuation remain blocked.');
    w.recoveryRequired=false;this.save();
  }
  private async stop(w:Worker,discard:boolean){
    // A checkpoint records assessment, never cleanup. Reconstructed workers
    // have no live head to terminate; require evidence before releasing them.
    this.verifyRecovery(w);
    w.discardReport=discard;
    this.activeReports.delete(w.id);
    if(!w.active&&!w.cleaning){if(discard){w.reportPending=false;this.save();}return;}
    w.active=false;this.cancelApprovals(w);w.status='stopped';w.report='Stopped by the app; work was not completed.';
    await this.clean(w);
    w.reportPending=!discard;this.save();this.emit({kind:'subagentEnded',id:w.id,status:w.status,summary:w.report??''});
  }
  async cancel(discardReports=true){const stopped=await Promise.allSettled([...this.workers.values()].map(w=>this.stop(w,discardReports)));this.emit({kind:'managedPending',pending:this.completionDependencies.length>0});if(stopped.some(r=>r.status==='rejected')||this.running.length)throw new Error('Worker cleanup incomplete; live or recovery dependencies retained.');}
  async close(){this.closed=true;await this.cancel(false);}
}
