import {randomUUID} from 'node:crypto';
import {readFileSync,mkdirSync} from 'node:fs';
import {writeFileAtomic} from '../durable/atomic';
import {join} from 'node:path';
import type {HeadHandlers} from './head';
import type {StreamItem} from './stream';
import type {CodexItem} from './codex';
import type {AgyConfig} from './agy';
import type {TerminateResult} from '../process/tree';

export interface AgyWorkerHead {
  start():void;send(text:string,uuid:string):void;
  answer(id:string,allow:boolean,input:Record<string,unknown>,message?:string):void;
  terminate(graceMs?:number):Promise<TerminateResult>;
}
interface Worker {id:string;name:string;instructions:string;sessionId:string;run:number;active:boolean;head?:AgyWorkerHead;report?:string;status?:string;reportPending?:boolean;}
/** App-managed ACP sessions. Native invoke_subagent remains disabled. */
export class AgyWorkers {
  private workers=new Map<string,Worker>();
  private closed=false;
  constructor(private config:AgyConfig,private emit:(i:CodexItem)=>void,private report:(id:string,text:string,run:number)=>void,private factory:(c:AgyConfig,h:HeadHandlers)=>AgyWorkerHead){
    if(!config.acpHome)throw new Error('Worker profile required.');
    if (!config.resume) return;
    try{const records=JSON.parse(readFileSync(join(config.acpHome,'workers.json'),'utf8'));if(!Array.isArray(records))throw new Error('Invalid worker state');for(const r of records){
      if(typeof r.id!=='string'||!/^[a-f0-9-]{36}$/.test(r.id)||typeof r.sessionId!=='string')throw new Error('Invalid worker identity');
      const w:Worker={...r,active:false,head:undefined,...(r.active?{status:'stopped',report:'ACP worker interrupted before its result. Resume explicitly with app_send_message if still authorized.',reportPending:true}:{})};this.workers.set(r.id,w);
      if(w.reportPending)this.deliverReport(w);
    }}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('ACP worker state is unreadable; preserved for recovery.');}
  }
  get running(){return [...this.workers.values()].filter(w=>w.active).map(w=>w.id);}
  get completionDependencies(){return [...this.workers.values()].filter(w=>w.active||w.reportPending).map(w=>({id:w.id,run:w.run,task:w.instructions,state:w.active?'running' as const:'reportQueued' as const,callback:'app_task_result' as const,taskTruncated:false}));}
  private save(){mkdirSync(this.config.acpHome!,{recursive:true});writeFileAtomic(join(this.config.acpHome!,'workers.json'),JSON.stringify([...this.workers.values()].map(({head,...w})=>w)));}
  async tool(name:string,args:Record<string,unknown>){
    if(this.closed)throw new Error('Worker manager closed.');
    if(name==='app_handoff'){
      if(typeof args.instructions!=='string'||!args.instructions.trim())throw new Error('Instructions required.');
      if(this.running.length>=4)throw new Error('Four ACP workers are already running.');
      const id=randomUUID(),w:Worker={id,name:typeof args.name==='string'?args.name:args.instructions.slice(0,80),instructions:args.instructions,sessionId:'',run:0,active:false};this.workers.set(id,w);
      this.launch(w,args.instructions);return {accepted:true,task_id:id};
    }
    const w=this.workers.get(String(args.task_id));if(!w)throw new Error('Unknown task_id.');
    if(name==='app_cancel_task'){await this.stop(w);return {task_id:w.id,status:'stopped'};}
    if(name==='app_send_message'){
      if(w.active)throw new Error('This ACP worker is busy; in-turn steering is unsupported.');
      if(typeof args.message!=='string'||!args.message.trim())throw new Error('Message required.');
      this.launch(w,args.message);return {accepted:true,task_id:w.id};
    }
    throw new Error('Unsupported worker tool.');
  }
  private launch(w:Worker,text:string){
    w.active=true;w.run++;const run=w.run;w.status='running';w.reportPending=false;delete w.report;this.save();
    this.emit({kind:'managedPending',pending:true});
    this.emit({kind:'toolUse',id:w.id,tool:'Agent',title:`Delegate ${w.name}`,detail:text,parent:null,input:{description:w.name,prompt:text,subagent_type:'agy-worker',run_in_background:true}});
    this.emit({kind:'subagentStarted',id:w.id,description:w.name,type:'agy-worker',prompt:text,background:true,execution:{run:w.run,ownerSessionId:this.config.sessionId,threadId:w.sessionId||null,turnId:null}});
    this.emit({kind:'subagentRuntime',id:w.id,runtime:{engine:'agy',reasoningEffort:this.config.effort}});
    const finish=(status:string,result:string)=>{
      if(!w.active||w.run!==run)return;w.active=false;w.status=status;w.report=result;w.reportPending=true;this.save();
      this.emit({kind:'subagentEnded',id:w.id,status,summary:result});
      if(!this.closed)this.deliverReport(w);
      void w.head?.terminate();w.head=undefined;
    };
    const onItem=(item:StreamItem)=>{
      if(w.run!==run)return;
      if(item.kind==='usage'){this.emit(item);return;}
      if(item.kind==='init'){w.sessionId=item.sessionId;this.save();return;}
      if(item.kind==='result'){finish(item.ok&&item.text.trim()?'completed':'failed',item.text||item.error||'Worker ended without an evidence report.');return;}
      if(item.kind==='permission'){this.emit({...item,requestId:`worker:${w.id}:${run}:${item.requestId}`,workerId:w.id});return;}
      if(item.kind==='permissionCancelled'){this.emit({...item,requestId:`worker:${w.id}:${run}:${item.requestId}`});return;}
      if(item.kind==='delta'){this.emit({kind:'subagentText',parent:w.id,text:item.text});return;}
      if(item.kind==='toolUse'||item.kind==='toolResult'){this.emit({...item,parent:w.id,id:`${w.id}:${item.id}`});}
    };
    try{
      w.head=this.factory({...this.config,worker:true,acpHome:join(this.config.acpHome!,'workers',w.id),sessionId:w.sessionId||randomUUID(),resume:!!w.sessionId,systemPrompt:`${this.config.systemPrompt??''}\nYou are an execution worker, not the coordinator. Execute only the assigned authorized scope. Do not delegate or emit handoff/team/plugin tags. Preserve permission protections. Return concrete results, tests, and blockers. Worker report is not acceptance of the overall task.`},{onItem,onExit:e=>{if(w.active)finish(e.expected?'stopped':'failed',e.stderr||'ACP worker exited before a result.');}});
      w.head.start();w.head.send(text,randomUUID());
    }catch(error){finish('failed',(error as Error).message);}
  }
  private deliverReport(w:Worker){
    this.report(w.id,`<app_task_result task_id="${w.id}" run="${w.run}" status="${w.status}">\n${w.report??''}\n</app_task_result>\nWorker completion is execution evidence, not acceptance of the user's full objective. Assess the result and continue authorized work as needed.`,w.run);
  }
  acknowledgeReport(id:string,run:number){const w=this.workers.get(id);if(w?.run===run){w.reportPending=false;this.save();}}
  answer(id:string,allow:boolean,input:Record<string,unknown>,message?:string){const match=/^worker:([a-f0-9-]{36}):(\d+):(.+)$/.exec(id);if(match){const worker=this.workers.get(match[1]!);if(worker?.active&&worker.run===Number(match[2]))worker.head?.answer(match[3]!,allow,input,message);}}
  private async stop(w:Worker){if(!w.active)return;w.active=false;w.status='stopped';w.reportPending=false;this.save();await w.head?.terminate();w.head=undefined;this.emit({kind:'subagentEnded',id:w.id,status:'stopped',summary:'Stopped by the app.'});}
  async cancel(discardReports=true){if(discardReports)for(const w of this.workers.values())w.reportPending=false;await Promise.all([...this.workers.values()].map(w=>this.stop(w)));this.save();this.emit({kind:'managedPending',pending:false});}
  async close(){this.closed=true;await this.cancel(false);}
}
