import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bot } from "../../src/core/bot";
import { CodexSession } from "../../src/core/agent/codex";
import { ProcessLedger } from "../../src/core/process/ledger";
import { mainProfile } from "../../src/core/store/workspace";
import { TokenFlowLedger, tokenLedger, type MeteredTurn } from "../../src/core/token-flow-ledger";
import { TokenFlowContexts } from "../../src/core/token-flow-context";
import { tempDir } from "../helpers";
function fixture(engine:"codex"|"claude") {
 const dir=tempDir("flow-review"),profile=mainProfile(dir);mkdirSync(profile.storeDir,{recursive:true});
 writeFileSync(join(profile.storeDir,"bot.json"),JSON.stringify({engine,heads:{engines:[engine],answerWith:engine}}));
 const bot=new Bot({profile,engine,deferStartup:true,welcome:false,ledger:new ProcessLedger(join(dir,"process.json")),headConfig(){throw Error("No CLI");},prompts(){throw Error("No model");},emit(){},log(){},approvalTimeoutMs:100,idleMs:100000,interruptGraceMs:100});
 expect(bot.engine).toBe(engine);
 const head={} as any;(bot as any).head=head;
 const turn=(message:string,name:string,declared=true)=>{
  const id=bot.tasks.begin(message,name,engine,1);Object.assign(bot.tasks.task(id)!,{name,declared});
  const t=(bot as any).newTurn("user",name,message);t.head=head;t.sent=true;(bot as any).turn=t;return {id,t};
 };
 return {bot,head,dir,profile,turn,file:join(profile.storeDir,"token-flow-turns.jsonl"),async close(){(bot as any).head=null;(bot as any).turn=null;await bot.shutdown({tidy:false});}};
}
const measurement=(turnId:string,workerId:string|null,run:number|null):Omit<MeteredTurn,"botId"|"head"|"taskId">=>({threadId:"worker-thread",turnId,workerId,run,parentThreadId:"parent",startedAt:1,endedAt:2,source:"provider-turn",scope:"exclusive",tokens:{input:5,output:2,cacheRead:3,cacheWrite:0},activities:[],complete:true});

it("regression: real app_send_message reuse binds run 2 to task B, and late run 1 replay stays on task A after restart",async()=>{
 const f=fixture("codex");const {bot,head,turn,file}=f;
 const s=new CodexSession({cwd:f.dir,instructions:"fixture",workerInstructions:"fixture",resumeThread:null,model:null,workerModel:null,effort:null,restoredWorkers:[]});
 const sink=(out:any[])=>{for(const o of out)if(o.kind==="item")(bot as any).onItem(head,o.item);return out;};
 const req=(out:any[],method:string)=>out.find(o=>o.kind==="write"&&o.value.method===method)!.value;
 const response=(r:any,result:any)=>sink(s.receive(JSON.stringify({id:r.id,result})));
 const note=(method:string,params:any)=>sink(s.receive(JSON.stringify({method,params})));
 const tool=(id:number,name:string,args:any)=>sink(s.receive(JSON.stringify({id,method:"item/tool/call",params:{threadId:"parent",turnId:"parent-turn",tool:name,arguments:args}})));
 try {
  response(req(response(req(s.start(),"initialize"),{}),"thread/start"),{thread:{id:"parent"}});
  response(req(s.send("fixture"),"turn/start"),{turn:{id:"parent-turn"}});
  const a=turn("user-a","Task A");
  const dispatch=tool(100,"app_handoff",{instructions:"fixture",name:"worker"});
  const worker=dispatch.find(o=>o.kind==="item"&&o.item.kind==="subagentStarted").item.id;
  response(req(response(req(dispatch,"thread/start"),{thread:{id:"worker-thread"}}),"turn/start"),{turn:{id:"run-one"}});
  note("thread/tokenUsage/updated",{threadId:"worker-thread",turnId:"run-one",tokenUsage:{total:{inputTokens:10,outputTokens:2}}});
  note("item/completed",{threadId:"worker-thread",turnId:"run-one",item:{type:"agentMessage",id:"report",text:"done"}});
  note("turn/completed",{threadId:"worker-thread",turn:{id:"run-one",status:"completed"}});
  const b=turn("user-b","Task B");
  const reuse=tool(101,"app_send_message",{task_id:worker,message:"second task"});
  response(req(reuse,"turn/start"),{turn:{id:"run-two"}});
  note("thread/tokenUsage/updated",{threadId:"worker-thread",turnId:"run-two",tokenUsage:{total:{inputTokens:30,outputTokens:6}}});
  note("item/completed",{threadId:"worker-thread",turnId:"run-two",item:{type:"agentMessage",id:"report2",text:"done"}});
  const ended=note("turn/completed",{threadId:"worker-thread",turn:{id:"run-two",status:"completed"}});
  sink(ended.filter(o=>o.kind==="item"&&(o.item.kind==="usage"||o.item.kind==="measurement")));
  const disk=new TokenFlowLedger(file),rows=[...disk.records.values()];
  expect(rows.find(r=>r.run===1)).toMatchObject({taskId:a.id,appTurnId:a.t.id});
  expect(rows.find(r=>r.run===2)).toMatchObject({taskId:b.id,appTurnId:b.t.id});
  // Reload receipts and replay old usage while another app turn is current.
  const receipts=new TokenFlowContexts(join(f.profile.storeDir,"token-flow-contexts.json"));
  expect((receipts.get as any)("codex",worker,2)).toMatchObject({taskId:b.id,appTurnId:b.t.id});
  (bot as any).recordMeasurement({...rows.find(r=>r.run===1)!});
  expect([...new TokenFlowLedger(file).records.values()].find(r=>r.run===1)?.taskId).toBe(a.id);
  expect([...new TokenFlowLedger(file).records.values()].reduce((n,r)=>n+r.tokens.input+r.tokens.output,0)).toBe(36);
 } finally {await f.close();}
});

it("regression: actual TaskBook named merge canonicalizes new measured turns and receipts, preserves unrelated historical evidence",async()=>{
 const f=fixture("claude");const {bot,turn,file}=f;
 try{
  const target=turn("target-message","Existing task");
  const provisional=turn("new-message","provisional",false);
  (bot as any).linkSubagent(provisional.t,"worker");
  (bot as any).recordMeasurement(measurement("before-merge","worker",null));
  const ledger=tokenLedger(file),before=[...ledger.records.values()][0];
  ledger.record({...before,turnId:"old-history",accountingVersion:undefined,appTurnId:undefined,attribution:undefined});
  const touched=bot.tasks.replied("reply",{head:"claude",userMessage:"new-message",usedTools:true},[{name:"Existing task",state:"running"}],3);
  expect(touched).toContain(target.id);expect(bot.tasks.task(provisional.id)).toBeUndefined();
  expect(bot.tasks.task(target.id)?.subagentIDs).toContain("worker");
  (bot as any).recordMeasurement(measurement("after-merge","worker",null));
  const reloaded=new TokenFlowLedger(file),rows=[...reloaded.records.values()];
  expect(rows.filter(r=>r.accountingVersion===2).map(r=>r.taskId)).toEqual([target.id,target.id]);
  expect(rows.find(r=>r.turnId==="old-history")?.taskId).toBe(provisional.id);
  expect(new TokenFlowContexts(join(f.profile.storeDir,"token-flow-contexts.json")).get("claude","worker")?.taskId).toBe(target.id);
  reloaded.record(before);
  expect([...new TokenFlowLedger(file).records.values()].find(r=>r.turnId==="before-merge")?.taskId).toBe(target.id);
 }finally{await f.close();}
});
