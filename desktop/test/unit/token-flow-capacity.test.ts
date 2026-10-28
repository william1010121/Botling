import { expect,it,vi } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as atomic from "../../src/core/durable/atomic";
import { join } from "node:path";
import { TokenFlowLedger, type MeteredTurn } from "../../src/core/token-flow-ledger";
import { tokenFlowContexts, TokenFlowContexts } from "../../src/core/token-flow-context";
import { meteredSummary } from "../../src/core/token-flow-summary";
import { tempDir } from "../helpers";
const bound=2048;
const record=(id:string,output=3,complete=true):MeteredTurn=>({botId:"bot",head:"codex",threadId:"thread",turnId:id,workerId:"worker",run:2,parentThreadId:"parent",taskId:"task-A",appTurnId:"app-turn-B",accountingVersion:2,attribution:"task",startedAt:1,endedAt:2,source:"provider-turn",scope:"exclusive",tokens:{input:10,output,cacheRead:20,cacheWrite:0},activities:[],complete});
const layout=(file:string)=>JSON.parse(fs.readFileSync(`${file}.manifest.json`,"utf8"));
const part=(file:string,generation:string,index:string|number)=>`${file}.g-${generation}.${index}.jsonl`;
const seed=(file:string)=>{const ledger=new TokenFlowLedger(file,bound);for(let i=0;i<9;i++)expect(ledger.record(record(String(i)))).toBe(true);return ledger;};

it("compacts and rotates beyond the old journal ceiling, retaining every identity, final snapshot, run owner and canonical alias after restart",()=>{
 const dir=tempDir("flow-capacity"),file=join(dir,"ledger.jsonl"),contexts=tokenFlowContexts(join(dir,"token-flow-contexts.json"));
 contexts.bind("codex","worker",{taskId:"task-A",appTurnId:"app-turn-B"},2);
 let ledger=new TokenFlowLedger(file,bound);
 for(let i=0;i<36;i++)for(let n=1;n<=4;n++)expect(ledger.record(record(String(i),n,n===4))).toBe(true);
 contexts.mergeTask("task-A","canonical");ledger.reconcileTasks();
 expect(ledger.record(record("next",4))).toBe(true);
 const manifest=layout(file);
 expect(manifest.parts.length).toBeGreaterThan(1);
 for(const [i,p] of manifest.parts.entries())expect(fs.statSync(part(file,manifest.generation,i)).size).toBeLessThanOrEqual(bound);
 expect(fs.statSync(part(file,manifest.generation,"journal")).size).toBeLessThanOrEqual(bound);
 expect(fs.statSync(file).size).toBeLessThanOrEqual(bound); // Original legacy bytes retained, not growing.
 ledger=new TokenFlowLedger(file,bound);
 expect(ledger.unreadable).toBe(false);expect(ledger.limited).toBe(false);expect(ledger.records.size).toBe(37);
 for(let i=0;i<36;i++)expect(ledger.record(record(String(i),1,false))).toBe(true);
 expect(ledger.records.size).toBe(37);expect([...ledger.records.values()].reduce((n,r)=>n+r.tokens.output,0)).toBe(148);
 expect([...ledger.records.values()].every(r=>r.taskId==="canonical"&&r.run===2&&r.appTurnId==="app-turn-B")).toBe(true);
 expect(new TokenFlowContexts(join(dir,"token-flow-contexts.json")).get("codex","worker",2)?.taskId).toBe("canonical");
});

it("a failed generation publication leaves the old committed ledger authoritative; restart resumes without lost or duplicate records",()=>{
 const file=join(tempDir("flow-before-publish"),"ledger.jsonl"),ledger=seed(file);
 const originalManifest=fs.readFileSync(`${file}.manifest.json`,"utf8");
 const real=atomic.writeFileAtomic;
 const spy=vi.spyOn(atomic,"writeFileAtomic").mockImplementation((path,text)=>{if(path===`${file}.manifest.json`)throw Object.assign(Error("full"),{code:"ENOSPC"});real(path,text);});
 let rejected="";
 try{for(let i=9;i<30;i++){if(!ledger.record(record(String(i)))){rejected=String(i);break;}}}finally{spy.mockRestore();}
 expect(rejected).not.toBe("");expect(ledger.unreadable).toBe(true);expect(ledger.error).toContain("ENOSPC");
 expect(fs.readFileSync(`${file}.manifest.json`,"utf8")).toBe(originalManifest);
 const committed=[...ledger.records.keys()];const restarted=new TokenFlowLedger(file,bound);
 expect(restarted.unreadable).toBe(false);expect([...restarted.records.keys()]).toEqual(committed);
 expect(restarted.record(record(rejected))).toBe(true);expect(restarted.records.size).toBe(committed.length+1);
 // A later successful publication sweeps abandoned generations without touching referenced data.
 for(let i=40;i<48;i++)restarted.record(record(String(i)));
 const m=layout(file);const files=fs.readdirSync(join(file,".."));
 expect(files.filter(n=>n.includes(".g-")).every(n=>n.includes(m.generation))).toBe(true);
});

it("cleanup failure after publication cannot undo a durable generation or cause duplicate totals on restart",()=>{
 const file=join(tempDir("flow-after-publish"),"ledger.jsonl"),ledger=seed(file),old=layout(file).generation;
 const spy=vi.spyOn(fs,"rmSync").mockImplementation(()=>{throw Object.assign(Error("busy"),{code:"EBUSY"});});
 syncBuiltinESMExports();
 try{for(let i=9;i<18;i++)expect(ledger.record(record(String(i)))).toBe(true);}finally{spy.mockRestore();syncBuiltinESMExports();}
 expect(layout(file).generation).not.toBe(old);expect(fs.existsSync(part(file,old,0))).toBe(true);
 const restarted=new TokenFlowLedger(file,bound);expect(restarted.unreadable).toBe(false);expect(restarted.records.size).toBe(18);
 expect([...restarted.records.values()].reduce((n,r)=>n+r.tokens.output,0)).toBe(54);
});

it.each(["snapshot hash","missing journal","torn journal","missing manifest"])("fails closed on %s corruption, preserving files and stopping further appends",kind=>{
 const file=join(tempDir("flow-corrupt"),"ledger.jsonl");seed(file);const m=layout(file);
 const journal=part(file,m.generation,"journal");
 if(kind==="snapshot hash") {const p=part(file,m.generation,0);fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace('"output":3','"output":9'));}
 if(kind==="missing manifest")fs.rmSync(`${file}.manifest.json`);
 if(kind==="missing journal")fs.rmSync(journal);
 if(kind==="torn journal")fs.appendFileSync(journal,'{"turnId":');
 const stopped=new TokenFlowLedger(file,bound);
 expect(stopped.unreadable).toBe(true);expect(stopped.error).toBeTruthy();expect(stopped.record(record("must-not-append"))).toBe(false);
});

it("continues collecting at the production 16 MiB boundary and deduplicates the retained original after restart",()=>{
 const file=join(tempDir("flow-production-bound"),"ledger.jsonl"),limit=16*1024*1024;
 const line=JSON.stringify(record("repeated"))+"\n";
 fs.writeFileSync(file,line.repeat(Math.floor(limit/Buffer.byteLength(line))));
 const ledger=new TokenFlowLedger(file);
 expect(ledger.records.size).toBe(1);expect(ledger.record(record("new"))).toBe(true);
 expect(fs.existsSync(`${file}.manifest.json`)).toBe(true);
 const restarted=new TokenFlowLedger(file);expect(restarted.unreadable).toBe(false);expect(restarted.records.size).toBe(2);
 expect(restarted.record(record("repeated"))).toBe(true);expect(restarted.records.size).toBe(2);
});

it("surfaces receipt storage failure on refresh even before another measurement arrives",()=>{
 const dir=tempDir("flow-context-io"),file=join(dir,"ledger.jsonl"),contextFile=join(dir,"token-flow-contexts.json");
 const ledger=new TokenFlowLedger(file);expect(ledger.record(record("saved"))).toBe(true);
 fs.mkdirSync(contextFile);
 tokenFlowContexts(contextFile).bind("codex","worker",{taskId:"task-A",appTurnId:"app-turn-B"},2);
 const view=meteredSummary(ledger,"bot");expect(view.unreadable).toBe(true);expect(view.error).toContain("attribution storage");
 expect(ledger.record(record("stopped"))).toBe(false);expect(ledger.records.size).toBe(1);
});
