import {expect,it} from 'vitest';
import {CodexSession,type WorkerRecord,type CodexOutput,type CodexConfig} from '../../src/core/agent/codex';
const writes=(out:CodexOutput[])=>out.flatMap(o=>o.kind==='write'?[o.value as any]:[]);
const items=(out:CodexOutput[])=>out.flatMap(o=>o.kind==='item'?[o.item]:[]);
const record:WorkerRecord={id:'original-task',name:'Research',instructions:'Research only; no implementation.',thread:'original-worker',run:4,wasActive:true,reportPending:false,restartSafe:true,restartTurn:'old-turn'};
function boot(records:WorkerRecord[]=[record], options:Partial<CodexConfig>={}){
 const s=new CodexSession({cwd:'/tmp',instructions:'Coordinator',workerInstructions:'Worker',resumeThread:'original-owner',model:null,workerModel:null,effort:null,restoredWorkers:[],restartWorkers:records,ownerSession:'original-session',...options});
 const answer=(id:number,result:any)=>s.receive(JSON.stringify({id,result}));
 if(options.restartTurn)s.send("Resume unfinished authorized work");
 s.start();answer(1,{});const setup=writes(answer(2,{thread:{id:'original-owner'}}));
 const out=answer(setup.find(x=>x.method==='thread/inject_items').id,{});
 return {s,answer,read:writes(out).find(x=>x.method==='thread/read')};
}
it('reconciles original child before resume, retaining task/owner/thread and research scope (as its next run)',()=>{
 const {s,answer,read}=boot();expect(read.params).toEqual({threadId:'original-worker',includeTurns:true});
 const resumed=answer(read.id,{thread:{id:'original-worker',turns:[{id:'old-turn',status:'interrupted',items:[]}]}});
 const call=writes(resumed).find(x=>x.method==='thread/resume');expect(call.params.threadId).toBe('original-worker');
 expect(items(resumed)).toContainEqual(expect.objectContaining({kind:'subagentStarted',id:'original-task',execution:expect.objectContaining({run:5,ownerSessionId:'original-session',threadId:'original-worker'})}));
 const injected=writes(answer(call.id,{thread:{id:'original-worker'}})).find(x=>x.method==='thread/inject_items');
 const started=writes(answer(injected.id,{})).find(x=>x.method==='turn/start');
 expect(started.params.input[0].text).toContain('Research only; no implementation.');
 expect(s.workerRecords[0]).toMatchObject({id:'original-task',thread:'original-worker',run:5,wasActive:true,instructions:'Research only; no implementation.'});
});
it('completion-before-crash delivers the existing result without re-running the worker',()=>{
 const {answer,read}=boot();
 const out=answer(read.id,{thread:{id:'original-worker',turns:[{id:'old-turn',status:'completed',items:[{type:'agentMessage',text:'Verified research evidence',phase:'final_answer'}]}]}});
 expect(writes(out).filter(x=>x.params?.threadId==='original-worker')).toEqual([]);
 expect(items(out)).toContainEqual(expect.objectContaining({kind:'subagentEnded',id:'original-task',status:'completed',summary:'Verified research evidence'}));
});
it.each(['inProgress','failed',undefined])('unknown/unsafe provider outcome %s is surfaced without replay',status=>{
 const {answer,read}=boot();const out=answer(read.id,{thread:{id:'original-worker',turns:[{id:'old-turn',status}]}});
 expect(writes(out)).toEqual([]);expect(items(out)).toContainEqual(expect.objectContaining({kind:'subagentEnded',status:'interrupted'}));
});
it('cancelled and completed children do not resume; uncertain reports do not wake twice',()=>{
 const {read}=boot([{...record,wasActive:false,reportPending:false},{...record,id:'uncertain-report',wasActive:false,reportPending:true,reportDispatching:true,report:'Already sent?',status:'completed'}]);
 expect(read).toBeUndefined();
});
it('does not retry a command that started after the shutdown snapshot but has no confirmed result',()=>{
 const {answer,read}=boot();const out=answer(read.id,{thread:{id:'original-worker',turns:[{id:'old-turn',status:'interrupted',items:[{type:'commandExecution',id:'late-command',status:'inProgress'}]}]}});
 expect(writes(out)).toEqual([]);expect(items(out)).toContainEqual(expect.objectContaining({kind:'subagentEnded',status:'interrupted'}));
});
it('does not substitute a new worker conversation when resume returns another ID',()=>{
 const {answer,read}=boot();const resumed=answer(read.id,{thread:{id:'original-worker',turns:[{id:'old-turn',status:'interrupted',items:[]}]}});
 const call=writes(resumed).find(x=>x.method==='thread/resume');
 const out=answer(call.id,{thread:{id:'wrong-worker'}});
 expect(writes(out).some(x=>x.method==='turn/start'&&x.params.threadId==='wrong-worker')).toBe(false);
 expect(items(out)).toContainEqual(expect.objectContaining({kind:'subagentEnded',status:'failed'}));
});
it('completed coordinator turn is recovered without sending another prompt',()=>{
 const {answer,read}=boot([],{strictResume:true,restartTurn:'coordinator-turn'});
 const out=answer(read.id,{thread:{id:'original-owner',turns:[{id:'coordinator-turn',status:'completed',items:[{type:'agentMessage',text:'Already finished',phase:'final_answer'}]}]}});
 expect(writes(out)).toEqual([]);expect(items(out)).toContainEqual(expect.objectContaining({kind:'result',ok:true,text:'Already finished'}));
});
it('confirmed interrupted coordinator resumes in the original thread',()=>{
 const {answer,read}=boot([],{strictResume:true,restartTurn:'coordinator-turn'});
 const out=answer(read.id,{thread:{id:'original-owner',turns:[{id:'coordinator-turn',status:'interrupted',items:[]}]}});
 expect(writes(out)).toContainEqual(expect.objectContaining({method:'turn/start',params:expect.objectContaining({threadId:'original-owner'})}));
});
it('unconfirmed coordinator turn is surfaced without a prompt',()=>{
 const {answer,read}=boot([],{strictResume:true,restartTurn:'coordinator-turn'});
 const out=answer(read.id,{thread:{id:'original-owner',turns:[{id:'coordinator-turn',status:'inProgress',items:[]}]}});
 expect(writes(out)).toEqual([]);expect(items(out)).toContainEqual(expect.objectContaining({kind:'result',ok:false,error:expect.stringContaining('unconfirmed')}));
});
it('cancellation during provider reconciliation prevents a late worker resume',()=>{
 const {s,answer,read}=boot();s.cancelWorkers(new Set(['original-task']));
 const out=answer(read.id,{thread:{id:'original-worker',turns:[{id:'old-turn',status:'interrupted',items:[]}]}});
 expect(writes(out)).toEqual([]);expect(s.runningWorkers).toEqual([]);expect(s.workerInfos[0]).toMatchObject({id:'original-task',run:4,state:'interrupted'});
});

// With the member's worker ledger (S4b): the restart's workers come from the ledger (interrupted by "restart", with the
// restart data the core kept when it closed), and the interrupted run goes on as the SAME run.
it('from the worker ledger: the run the restart interrupted resumes as the same run, task and thread kept',async()=>{
 const {WorkerCore,WorkerLedger}=await import('../../src/core/worker-core');
 const {mkdtempSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const file=join(mkdtempSync(join(tmpdir(),'codex-ledger-')),'worker-ledger.json');
 new WorkerLedger(file).save([{v:3,id:'original-task',engine:'codex',adapter:'codex-thread',name:'Research',instructions:'Research only; no implementation.',type:null,
   ownerSessionId:'original-session',run:4,status:'interrupted',interruptedBy:'restart',recovery:'required',report:{state:'none',text:null,status:'interrupted',attempts:0},
   conversationId:'original-worker',processes:[],createdAt:1,runStartedAt:1,endedAt:2_000,engineData:{restartSafe:true,restartTurn:'old-turn'}}]);
 const s=new CodexSession({cwd:'/tmp',instructions:'Coordinator',workerInstructions:'Worker',resumeThread:'original-owner',model:null,workerModel:null,effort:null,restoredWorkers:[],
   ownerSession:'original-session',restartRecovery:1_000,workerCore:(options)=>new WorkerCore({...options,store:new WorkerLedger(file)})});
 const answer=(id:number,result:any)=>s.receive(JSON.stringify({id,result}));
 s.start();answer(1,{});const setup=writes(answer(2,{thread:{id:'original-owner'}}));
 const read=writes(answer(setup.find(x=>x.method==='thread/inject_items').id,{})).find(x=>x.method==='thread/read');
 expect(read.params).toEqual({threadId:'original-worker',includeTurns:true});
 const resumed=answer(read.id,{thread:{id:'original-worker',turns:[{id:'old-turn',status:'interrupted',items:[]}]}});
 expect(items(resumed)).toContainEqual(expect.objectContaining({kind:'subagentStarted',id:'original-task',execution:expect.objectContaining({run:4,threadId:'original-worker'})}));
 expect(s.core.get('original-task')).toMatchObject({status:'running',run:4});
});
