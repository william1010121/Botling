import { expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexSession, type CodexConfig, type CodexOutput } from "../../src/core/agent/codex";
import { Bot } from "../../src/core/bot";
import { ProcessLedger } from "../../src/core/process/ledger";
import { mainProfile } from "../../src/core/store/workspace";
import { TokenFlowLedger, meteredPurpose } from "../../src/core/token-flow-ledger";
import { meteredSummary } from "../../src/core/token-flow-summary";
import { tokenFlowHistory } from "../../src/core/token-flow-history";
import { tempDir } from "../helpers";
const config = (resumeThread: string | null = null): CodexConfig => ({ cwd:"/fixture",instructions:"fixture",workerInstructions:"fixture",resumeThread,model:null,workerModel:null,effort:null,restoredWorkers:[] });
const request = (out: CodexOutput[], method: string) => out.find((o): o is Extract<CodexOutput,{kind:"write"}> => o.kind==="write" && o.value.method===method)!.value;
const response = (s:CodexSession,r:Record<string,unknown>,result:unknown)=>s.receive(JSON.stringify({id:r.id,result}));
const note=(s:CodexSession,method:string,params:unknown)=>s.receive(JSON.stringify({method,params}));
function ready(thread:string){const s=new CodexSession(config());const init=request(s.start(),"initialize");const start=request(response(s,init,{}),"thread/start");response(s,start,{thread:{id:thread}});return s;}

it("routes real protocol usage through the Bot bridge into durable whole-bot history: main execution, worker coordination, mixed, replay, restart and day rollover",async()=>{
 const dir=tempDir("flow-production"),profile=mainProfile(dir);mkdirSync(profile.storeDir,{recursive:true});
 writeFileSync(join(profile.storeDir,"bot.json"),JSON.stringify({engine:"codex",heads:{engines:["codex"],answerWith:"codex"}}));
 const bot=new Bot({profile,engine:"codex",deferStartup:true,welcome:false,ledger:new ProcessLedger(join(dir,"process.json")),headConfig(){throw Error("No CLI");},prompts(){throw Error("No turn");},emit(){},log(){},approvalTimeoutMs:100,idleMs:100,interruptGraceMs:100});
 const head={} as any;(bot as any).head=head;
 const sink=(out:CodexOutput[])=>{for(const o of out)if(o.kind==="item" && o.item.kind==="usage")(bot as any).onItem(head,o.item);return out;};
 let now=new Date(2026,9,28,23,59).getTime();const clock=vi.spyOn(Date,"now").mockImplementation(()=>now);
 try{
  const s=ready("chat-one");response(s,request(s.send("fixture"),"turn/start"),{turn:{id:"t1"}});
  note(s,"item/started",{threadId:"chat-one",turnId:"t1",item:{type:"commandExecution",id:"shell",command:"echo fixture"}});
  note(s,"thread/tokenUsage/updated",{threadId:"chat-one",turnId:"t1",tokenUsage:{total:{inputTokens:100,cachedInputTokens:40,outputTokens:20}}});
  const first=sink(note(s,"turn/completed",{threadId:"chat-one",turn:{id:"t1",status:"completed"}}));sink(first); // exact transport replay
  now=new Date(2026,9,29,0,1).getTime();
  response(s,request(s.send("fixture2"),"turn/start"),{turn:{id:"t2"}});
  // A structured dispatch is coordination evidence, including the actual dynamic-tool request path.
  const handoff=s.receive(JSON.stringify({id:900,method:"item/tool/call",params:{threadId:"chat-one",turnId:"t2",tool:"app_handoff",arguments:{instructions:"PRIVATE FIXTURE",name:"Worker"}}}));
  const started=handoff.find(o=>o.kind==="item"&&o.item.kind==="subagentStarted") as any;const workerId=started.item.id;
  const workerStart=request(handoff,"thread/start");const workerTurn=request(response(s,workerStart,{thread:{id:"worker-thread"}}),"turn/start");response(s,workerTurn,{turn:{id:"wt1"}});
  note(s,"item/started",{threadId:"worker-thread",turnId:"wt1",item:{type:"dynamicToolCall",id:"coord",tool:"app_send_message",arguments:{message:"PRIVATE"}}});
  note(s,"thread/tokenUsage/updated",{threadId:"worker-thread",turnId:"wt1",tokenUsage:{total:{inputTokens:50,cachedInputTokens:10,outputTokens:10}}});
  note(s,"item/completed",{threadId:"worker-thread",turnId:"wt1",item:{type:"agentMessage",id:"report",text:"fixture report"}});
  sink(note(s,"turn/completed",{threadId:"worker-thread",turn:{id:"wt1",status:"completed"}}));
  note(s,"item/started",{threadId:"chat-one",turnId:"t2",item:{type:"fileChange",id:"edit",changes:[]}});
  note(s,"thread/tokenUsage/updated",{threadId:"chat-one",turnId:"t2",tokenUsage:{total:{inputTokens:150,cachedInputTokens:50,outputTokens:40}}});
  const handback=sink(note(s,"turn/completed",{threadId:"chat-one",turn:{id:"t2",status:"completed"}}));
  response(s,request(handback,"turn/start"),{turn:{id:"report-turn"}});
  note(s,"thread/tokenUsage/updated",{threadId:"chat-one",turnId:"report-turn",tokenUsage:{total:{inputTokens:160,cachedInputTokens:50,outputTokens:42}}});
  sink(note(s,"turn/completed",{threadId:"chat-one",turn:{id:"report-turn",status:"completed"}}));
  // Another historical chat remains under the same stable bot identity.
  const second=ready("chat-two");response(second,request(second.send("fixture3"),"turn/start"),{turn:{id:"t3"}});
  note(second,"thread/tokenUsage/updated",{threadId:"chat-two",tokenUsage:{total:{inputTokens:10,outputTokens:5}}});
  sink(note(second,"turn/completed",{threadId:"chat-two",turn:{id:"t3",status:"completed"}}));
  const file=join(profile.storeDir,"token-flow-turns.jsonl"),restarted=new TokenFlowLedger(file),records=[...restarted.records.values()];
  expect(records).toHaveLength(5);expect(records.map(meteredPurpose)).toEqual(["execution","communication","mixed","communication","unknown"]);
  expect(records.find(r=>r.workerId)).toMatchObject({botId:bot.id,head:"codex",workerId,run:1,threadId:"worker-thread",turnId:"wt1",parentThreadId:"chat-one",tokens:{input:40,cacheRead:10,output:10,cacheWrite:0}});
  restarted.record(records[0]);expect(new TokenFlowLedger(file).records.size).toBe(5);
  const summary=meteredSummary(restarted,bot.id,now);
  expect(new Set(summary.periods.all.filter(g=>!g.workerId && g.purpose!=="unknown").map(g=>g.workId)).size).toBe(1);
  expect(summary.periods.all.reduce((n,g)=>n+g.tokens.output,0)).toBe(57);
  expect(summary.periods.today.reduce((n,g)=>n+g.tokens.output,0)).toBe(37);
  expect((await tokenFlowHistory(bot)).metered?.periods.all.reduce((n,g)=>n+g.tokens.output,0)).toBe(57);
  expect(readFileSync(file,"utf8")).not.toContain("PRIVATE");
  expect(meteredSummary(restarted,"new-bot-with-same-name",now).periods.all).toEqual([]);
 }finally{clock.mockRestore();(bot as any).head=null;await bot.shutdown({tidy:false});}
});


it("does not assign resumed lifetime totals, foreign turn updates or late idle usage to the next turn",()=>{
 const s=ready("chat");response(s,request(s.send("first"),"turn/start"),{turn:{id:"one"}});
 note(s,"thread/tokenUsage/updated",{threadId:"chat",turnId:"foreign",tokenUsage:{total:{inputTokens:9000,outputTokens:9000}}});
 let ended=note(s,"turn/completed",{threadId:"chat",turn:{id:"one",status:"completed"}});
 expect(ended.some(o=>o.kind==="item"&&o.item.kind==="usage"&&o.item.measurement)).toBe(false);
 note(s,"thread/tokenUsage/updated",{threadId:"chat",turnId:"one",tokenUsage:{total:{inputTokens:100,outputTokens:20}}});
 response(s,request(s.send("second"),"turn/start"),{turn:{id:"two"}});
 note(s,"thread/tokenUsage/updated",{threadId:"chat",turnId:"two",tokenUsage:{total:{inputTokens:110,outputTokens:25}}});
 ended=note(s,"turn/completed",{threadId:"chat",turn:{id:"two",status:"completed"}});
 const usage=ended.find(o=>o.kind==="item"&&o.item.kind==="usage") as any;
 expect(usage.item.measurement.tokens).toEqual({input:10,output:5,cacheRead:0,cacheWrite:0});
 const resumed=new CodexSession({...config("past"),workerInstructions:null});
 const init=request(resumed.start(),"initialize");response(resumed,request(response(resumed,init,{}),"thread/resume"),{thread:{id:"past"}});
 response(resumed,request(resumed.send("resume"),"turn/start"),{turn:{id:"resumed"}});
 note(resumed,"thread/tokenUsage/updated",{threadId:"past",turnId:"resumed",tokenUsage:{total:{inputTokens:50000,outputTokens:10000}}});
 expect(note(resumed,"turn/completed",{threadId:"past",turn:{id:"resumed",status:"completed"}}).some(o=>o.kind==="item"&&o.item.kind==="usage"&&o.item.measurement)).toBe(false);
});
