import { createHash } from "node:crypto";
import { noTokens, plusTokens, totalTokens, type TokenUsage } from "./usage";
import { meteredPurpose, type MeteredPurpose, type TokenFlowLedger } from "./token-flow-ledger";
export interface MeteredGroup { id:string; workId?:string; head:string | null; workerId:string | null; taskId:string | null; purpose:MeteredPurpose; tokens:TokenUsage; turns:number; threadId?:string; parentThreadId?:string|null; missing?:number; partial?:number; messages?:number; attribution?:"task"|"chat"|"unresolved"|"historical"|"aggregated" }
export function meteredSummary(ledger: TokenFlowLedger, botId: string, now=Date.now()) {
 ledger.reconcileTasks();
 const today=new Date(now);today.setHours(0,0,0,0);const week=new Date(today);week.setDate(week.getDate()-6);
 const records=[...ledger.records.values()].filter(r=>r.botId===botId);
 const group=(start:number)=>{
  const map=new Map<string,MeteredGroup>();
  for(const r of records) if(r.endedAt>=start && r.endedAt<=now){
   const purpose=meteredPurpose(r);
   const workId=createHash("sha256").update(JSON.stringify([r.head,r.threadId,r.workerId,r.taskId])).digest("hex");
   const id=createHash("sha256").update(JSON.stringify([r.head,r.threadId,r.workerId,r.taskId,purpose,r.attribution??"historical"])).digest("hex");
   const g=map.get(id)??{id,workId,head:r.head,workerId:r.workerId,taskId:r.taskId,purpose,tokens:noTokens(),turns:0,threadId:r.threadId,parentThreadId:r.parentThreadId,attribution:r.attribution??"historical",missing:0,partial:0,messages:0};
   if (!r.missingUsage) g.tokens=plusTokens(g.tokens,r.tokens);g.turns++;g.missing=(g.missing??0)+Number(!!r.missingUsage);g.partial=(g.partial??0)+Number(!r.complete);g.messages=(g.messages??0)+Number(r.source==="provider-message");map.set(id,g);
  }
  const groups=[...map.values()].sort((a,b)=>totalTokens(b.tokens)-totalTokens(a.tokens));
  if(groups.length<=200)return groups;
  // Preserve all totals/purposes when grouping exceeds the display bound.
  const head=groups.slice(0,196),tail=groups.slice(196);
  for(const purpose of ["communication","execution","mixed","unknown"] as const){
   const rest=tail.filter(x=>x.purpose===purpose);if(!rest.length)continue;
   head.push({id:`other-${purpose}`,head:null,workerId:null,taskId:null,attribution:"aggregated",purpose,tokens:rest.reduce((a,x)=>plusTokens(a,x.tokens),noTokens()),turns:rest.reduce((a,x)=>a+x.turns,0),missing:rest.reduce((a,x)=>a+(x.missing??0),0),partial:rest.reduce((a,x)=>a+(x.partial??0),0),messages:rest.reduce((a,x)=>a+(x.messages??0),0)});
  }
  return head;
 };
 return {since:records.length?records.reduce((earliest,r)=>Math.min(earliest,r.startedAt),Infinity):null,limited:ledger.limited,unreadable:ledger.unreadable,error:ledger.error,periods:{all:group(0),today:group(today.getTime()),'7d':group(week.getTime())}};
}
