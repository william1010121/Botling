import { TokenFlowHistoryView } from "../../src/contract";
import { expect, it } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ClaudeHead } from "../../src/core/agent/head";
import { ClaudeTokenFlowMeter } from "../../src/core/token-flow-claude";
import { TokenFlowLedger, type MeteredTurn } from "../../src/core/token-flow-ledger";
import { TokenFlowContexts } from "../../src/core/token-flow-context";
import { TokenFlowMeter } from "../../src/core/token-flow-meter";
import { meteredTask } from "../../src/core/token-flow-task";
import { meteredSummary } from "../../src/core/token-flow-summary";
import { taskFlowGroups, agentKey, measuredAmount } from "../../src/renderer/token-flow-graph-model";
import { Bot } from "../../src/core/bot";
import { ProcessLedger } from "../../src/core/process/ledger";
import { mainProfile } from "../../src/core/store/workspace";
import { tempDir } from "../helpers";
const usage=(input=10,output=5,read=20,write=2)=>({input_tokens:input,output_tokens:output,cache_read_input_tokens:read,cache_creation_input_tokens:write});
const assistant=(id:string,parent:string|null,content:any[],u:any=usage())=>({type:"assistant",session_id:"session",parent_tool_use_id:parent,message:{id,model:"claude",content,usage:u,stop_reason:"tool_use"}});
const tool=(id:string,name="Agent")=>({type:"tool_use",id,name,input:{description:"Fixture child",prompt:"PRIVATE PROMPT"}});

it("collects real Claude stream envelopes through Head → Bot; parent and nested children own disjoint messages and an explicit task",async()=>{
 const dir=tempDir("forward-claude"),profile=mainProfile(dir);mkdirSync(profile.storeDir,{recursive:true});
 const bot=new Bot({profile,engine:"claude",deferStartup:true,welcome:false,ledger:new ProcessLedger(join(dir,"process.json")),headConfig(){throw Error("No CLI");},prompts(){throw Error("No model calls");},emit(){},log(){},approvalTimeoutMs:100,idleMs:100000,interruptGraceMs:100});
 const head=new ClaudeHead({command:"never-run",cwd:dir,sessionId:"session",resume:false,allowedTools:[]},{onItem(item){(bot as any).onItem(head,item);},onExit(){}});
 (bot as any).head=head;
 const taskId=bot.tasks.begin("user","Fixture task","claude",1);
 const task=bot.tasks.task(taskId)!;task.declared=true;task.name="Fixture task";
 const turn=(bot as any).newTurn("user","Fixture task","user");turn.head=head;turn.sent=true;(bot as any).turn=turn;
 const send=(frame:any)=>(head as any).line(JSON.stringify(frame));
 try {
  send(assistant("parent",null,[tool("child")]));
  send(assistant("child-message","child",[tool("grandchild")]));
  send(assistant("grandchild-message","grandchild",[{type:"text",text:"Child result"}],usage(7,8,30,4)));
  // The aggregate result amount is deliberately huge: it must never be re-added to message usage.
  send({type:"result",subtype:"success",result:"Done",total_cost_usd:1,usage:usage(9999,9999,9999,9999)});
  const file=join(profile.storeDir,"token-flow-turns.jsonl");
  const ledger=new TokenFlowLedger(file),records=[...ledger.records.values()];
  expect(records).toHaveLength(3);
  expect(records.map(r=>r.taskId)).toEqual([taskId,taskId,taskId]);
  expect(records.map(r=>r.attribution)).toEqual(["task","task","task"]);
  expect(records[1]).toMatchObject({workerId:"child",parentThreadId:"session",tokens:{input:10,output:5,cacheRead:20,cacheWrite:2}});
  expect(records[2]).toMatchObject({workerId:"grandchild",parentThreadId:"session:child"});
  for(const record of records) ledger.record({...record,taskId:"wrong-replayed-task"});
  const restarted=new TokenFlowLedger(file);
  expect([...restarted.records.values()].reduce((n,r)=>n+Object.values(r.tokens).reduce((a,b)=>a+b,0),0)).toBe(123);
  expect([...restarted.records.values()].every(r=>r.taskId===taskId&&r.complete)).toBe(true);
  const context=new TokenFlowContexts(join(profile.storeDir,"token-flow-contexts.json"));
  expect(context.get("claude","child")).toMatchObject({taskId,appTurnId:turn.id});
  expect(readFileSync(file,"utf8")).not.toContain("PRIVATE");
 } finally { (bot as any).head=null;(bot as any).turn=null;await bot.shutdown({tidy:false}); }
});

it("replaces Claude partial cumulative snapshots across restart, handles stop/replay, cache normalization and unknown usage without result double count",()=>{
 const file=join(tempDir("message-restart"),"ledger.jsonl");let ledger=new TokenFlowLedger(file);
 const meter=new ClaudeTokenFlowMeter("session");
 const sink=(frame:any)=>{for(const r of meter.observe(JSON.stringify(frame)))ledger.record({...r,botId:"bot",head:"claude",taskId:null,accountingVersion:2,attribution:"chat"});};
 sink({type:"stream_event",event:{type:"message_start",message:{id:"m1",usage:usage(10,1),model:"claude"}}});
 ledger=new TokenFlowLedger(file);
 sink({type:"stream_event",event:{type:"message_delta",usage:{output_tokens:8},delta:{stop_reason:"end_turn"}}});
 sink({type:"stream_event",event:{type:"message_stop"}});
 sink(assistant("m1",null,[],usage(10,1))); // stale final replay cannot lower a completed message
 sink({type:"result",total_cost_usd:5,usage:usage(1000,1000)});
 let records=[...new TokenFlowLedger(file).records.values()];
 expect(records).toHaveLength(1);expect(records[0]).toMatchObject({tokens:{input:10,output:8,cacheRead:20,cacheWrite:2},complete:true});
 sink(assistant("missing",null,[],{}));
 records=[...new TokenFlowLedger(file).records.values()];
 expect(records[1]).toMatchObject({missingUsage:true,complete:false});
 const groups=meteredSummary(new TokenFlowLedger(file),"bot").periods.all;
 expect(groups.reduce((n,r)=>n+(r.missing??0),0)).toBe(1);
 expect(groups.reduce((n,r)=>n+measuredAmount(r),0)).toBe(40);
});

it("records a Codex missing-baseline interval as an observable gap; resumed next interval uses differences, not lifetime or reasoning totals",()=>{
 const meter=new TokenFlowMeter();meter.begin("resumed","first");
 const update=(turnId:string,inputTokens:number,cachedInputTokens:number,outputTokens:number)=>meter.observe("thread/tokenUsage/updated",{threadId:"resumed",turnId,tokenUsage:{total:{inputTokens,cachedInputTokens,outputTokens,reasoningOutputTokens:100}}});
 update("first",1000,800,200);expect(meter.finish("resumed","first")).toBeNull();
 expect(meter.takeMissing()).toMatchObject({missingUsage:true,turnId:"first",complete:false});
 meter.begin("resumed","second");update("second",1100,840,220);
 expect(meter.finish("resumed","second")?.tokens).toEqual({input:60,cacheRead:40,output:20,cacheWrite:0});
});

it("keeps explicit chat, actual tasks, historical attribution and missing context separate while every dimension reconciles",()=>{
 const base:MeteredTurn={botId:"b",head:"codex",threadId:"p",turnId:"1",taskId:null,workerId:null,run:null,parentThreadId:null,startedAt:1,endedAt:2,tokens:{input:60,output:20,cacheRead:40,cacheWrite:0},complete:true,activities:["unclassified"],source:"provider-turn",scope:"exclusive"};
 const ledger=new TokenFlowLedger(join(tempDir("ownership"),"ledger.jsonl"));
 const records=[base,{...base,turnId:"2",attribution:"chat" as const,accountingVersion:2 as const},{...base,turnId:"3",taskId:"task",attribution:"task" as const},{...base,turnId:"4",threadId:"child",parentThreadId:"p",workerId:"child",taskId:"task",attribution:"task" as const},{...base,turnId:"5",attribution:"unresolved" as const}];
 records.forEach(r=>ledger.record(r));
 const metered=meteredSummary(ledger,"b",3);
 TokenFlowHistoryView.parse({botId:"b",asOf:3,limited:true,unreadable:false,rows:[],tasks:[],metered});
 const rows=metered.periods.all;
 const tasks=[{id:"task",name:"Actual task",workers:[]}];
 const groups=taskFlowGroups(rows,tasks);
 expect(groups.map(g=>g.name).sort()).toEqual(["Actual task","Chat / no task","Earlier / retained attribution","Missing dispatch context"].sort());
 expect(groups.reduce((n,g)=>n+g.total,0)).toBe(600);
 const agentTotals=new Map<string,number>();rows.forEach(r=>agentTotals.set(agentKey(r),(agentTotals.get(agentKey(r))??0)+measuredAmount(r)));
 expect([...agentTotals.values()].reduce((a,b)=>a+b,0)).toBe(600);
 expect(groups.find(g=>g.taskId==="task")!.rows.find(r=>r.workerId)?.parentThreadId).toBe("p");
});

it("does not guess task ownership from the current task, ambiguous links, cross-head collisions or provisional chat cards",()=>{
 const card:any={id:"task",name:"Task",owner:"codex",state:"running",declared:true,subagentIDs:["worker"],messageIDs:[],kept:true,createdAt:1,updatedAt:1};
 expect(meteredTask([card],"codex",["worker"],new Set())).toBe("task");
 expect(meteredTask([card,{...card,id:"second"}],"codex",["worker"],new Set())).toBeNull();
 expect(meteredTask([card],"codex",["worker"],new Set(["worker"]))).toBeNull();
 expect(meteredTask([card],"codex",["unlinked"],new Set(),"task")).toBeNull();
 expect(meteredTask([{...card,declared:false,subagentIDs:[]}],"codex",[],new Set(),"task")).toBeNull();
});

it("ships the mobile stylesheet requested by its HTML without requiring a package build",()=>{
 const require=createRequire(import.meta.url);const config=require("../../electron-builder.config.cjs");
 const mobile=config.extraResources.find((r:any)=>r.to==="mobile");
 expect(readFileSync(new URL("../../mobile/index.html",import.meta.url),"utf8")).toContain('token-flow.css');
 expect(mobile.filter).toContain("token-flow.css");
 expect(readFileSync(new URL("../../build-renderer.mjs",import.meta.url),"utf8")).toContain("token-flow.css");
});

it("links only newly observed explicit app turns after task declaration; replay and restart keep that association",()=>{
 const ledger=new TokenFlowLedger(join(tempDir("late-task-link"),"ledger.jsonl"));
 const record:MeteredTurn={botId:"b",head:"codex",threadId:"t",turnId:"one",workerId:null,run:null,parentThreadId:null,taskId:null,startedAt:1,endedAt:2,source:"provider-turn",scope:"exclusive",tokens:{input:10,output:5,cacheRead:20,cacheWrite:0},activities:[],complete:true};
 ledger.record(record);ledger.record({...record,turnId:"two",appTurnId:"app-turn",attribution:"chat",accountingVersion:2});
 ledger.linkTurn("b","codex","app-turn","real-task");
 const restarted=new TokenFlowLedger(ledger.file);restarted.record({...record,turnId:"two",appTurnId:"other-turn",attribution:"chat",accountingVersion:2});
 const rows=[...restarted.records.values()];expect(rows[0].taskId).toBeNull();expect(rows[1]).toMatchObject({taskId:"real-task",attribution:"task",appTurnId:"app-turn"});
});

it("routes Codex coordinator and app-managed child protocol events into the same explicit task without counting the child twice",async()=>{
 const {CodexSession}=await import("../../src/core/agent/codex");
 const dir=tempDir("forward-codex"),profile=mainProfile(dir);mkdirSync(profile.storeDir,{recursive:true});
 const bot=new Bot({profile,engine:"codex",deferStartup:true,welcome:false,ledger:new ProcessLedger(join(dir,"process.json")),headConfig(){throw Error("No CLI");},prompts(){throw Error("No model");},emit(){},log(){},approvalTimeoutMs:100,idleMs:100000,interruptGraceMs:100});
 const head={} as any;(bot as any).head=head;
 const taskId=bot.tasks.begin("user","Task","codex",1);Object.assign(bot.tasks.task(taskId)!,{declared:true,name:"Task"});
 const turn=(bot as any).newTurn("user","Task","user");turn.head=head;turn.sent=true;(bot as any).turn=turn;
 const s=new CodexSession({cwd:dir,instructions:"fixture",workerInstructions:"fixture",resumeThread:null,model:null,workerModel:null,effort:null,restoredWorkers:[]});
 const request=(out:any[],method:string)=>out.find(o=>o.kind==="write"&&o.value.method===method)!.value;
 const sink=(out:any[])=>{for(const o of out)if(o.kind==="item")(bot as any).onItem(head,o.item);return out;};
 const response=(req:any,result:any)=>sink(s.receive(JSON.stringify({id:req.id,result})));
 const note=(method:string,params:any)=>sink(s.receive(JSON.stringify({method,params})));
 try{
  response(request(response(request(s.start(),"initialize"),{}),"thread/start"),{thread:{id:"codex-parent"}});
  response(request(s.send("fixture"),"turn/start"),{turn:{id:"parent-turn"}});
  const dispatch=sink(s.receive(JSON.stringify({id:900,method:"item/tool/call",params:{threadId:"codex-parent",turnId:"parent-turn",tool:"app_handoff",arguments:{instructions:"PRIVATE",name:"Child"}}})));
  response(request(response(request(dispatch,"thread/start"),{thread:{id:"codex-child"}}),"turn/start"),{turn:{id:"child-turn"}});
  note("thread/tokenUsage/updated",{threadId:"codex-child",turnId:"child-turn",tokenUsage:{total:{inputTokens:50,cachedInputTokens:10,outputTokens:10}}});
  const partial=new TokenFlowLedger(join(profile.storeDir,"token-flow-turns.jsonl"));
  expect([...partial.records.values()]).toHaveLength(1);
  expect([...partial.records.values()][0]).toMatchObject({complete:false,tokens:{input:40,cacheRead:10,output:10,cacheWrite:0}});
  note("item/completed",{threadId:"codex-child",turnId:"child-turn",item:{type:"agentMessage",id:"report",text:"Done"}});
  note("turn/completed",{threadId:"codex-child",turn:{id:"child-turn",status:"completed"}});
  note("thread/tokenUsage/updated",{threadId:"codex-parent",turnId:"parent-turn",tokenUsage:{total:{inputTokens:100,cachedInputTokens:40,outputTokens:20}}});
  note("turn/completed",{threadId:"codex-parent",turn:{id:"parent-turn",status:"completed"}});
  const ledger=new TokenFlowLedger(join(profile.storeDir,"token-flow-turns.jsonl")),records=[...ledger.records.values()];
  expect(records).toHaveLength(2);expect(records.every(r=>r.taskId===taskId&&r.attribution==="task")).toBe(true);
  expect(records.find(r=>r.workerId)?.parentThreadId).toBe("codex-parent");
  expect(records.reduce((n,r)=>n+Object.values(r.tokens).reduce((a,b)=>a+b,0),0)).toBe(180);
 }finally{(bot as any).head=null;(bot as any).turn=null;await bot.shutdown({tidy:false});}
});

it("preserves Claude provider identity for the existing Codex-owned component-editor and rejects stale runs",async()=>{
 const {CodexSession}=await import("../../src/core/agent/codex");
 const s=new CodexSession({cwd:"/fixture",instructions:"fixture",workerInstructions:"fixture",resumeThread:null,model:null,workerModel:null,effort:null,restoredWorkers:[]});
 (s as any).workers.set("editor",{id:"editor",role:"component-editor",run:2,active:true});
 (s as any).threadId="codex-parent";
 const meter=new ClaudeTokenFlowMeter("claude-child");
 const measurement=meter.observe(JSON.stringify(assistant("message",null,[])))[0];
 expect(s.componentEditorItem("editor",1,{kind:"measurement",provider:"claude",measurement})).toEqual([]);
 const out=s.componentEditorItem("editor",2,{kind:"measurement",provider:"claude",measurement}) as any[];
 expect(out[0].item).toMatchObject({kind:"measurement",provider:"claude",measurement:{workerId:"editor",run:2,parentThreadId:"codex-parent",source:"provider-message"}});
});
