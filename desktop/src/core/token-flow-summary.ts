import { createHash } from "node:crypto";
import { noTokens, plusTokens, totalTokens, type TokenUsage } from "./usage";
import { meteredPurpose, type MeteredPurpose, type TokenFlowLedger } from "./token-flow-ledger";
export interface MeteredGroup { id:string; head:string | null; workerId:string | null; taskId:string | null; purpose:MeteredPurpose; tokens:TokenUsage; turns:number }
export function meteredSummary(ledger: TokenFlowLedger, botId: string, now=Date.now()) {
 const today=new Date(now);today.setHours(0,0,0,0);const week=new Date(today);week.setDate(week.getDate()-6);
 const records=[...ledger.records.values()].filter(r=>r.botId===botId);
 const group=(start:number)=>{
  const map=new Map<string,MeteredGroup>();
  for(const r of records) if(r.endedAt>=start && r.endedAt<=now){
   const purpose=meteredPurpose(r);
   const id=createHash("sha256").update(JSON.stringify([r.head,r.threadId,r.workerId,r.taskId,purpose])).digest("hex");
   const g=map.get(id)??{id,head:r.head,workerId:r.workerId,taskId:r.taskId,purpose,tokens:noTokens(),turns:0};
   g.tokens=plusTokens(g.tokens,r.tokens);g.turns++;map.set(id,g);
  }
  const groups=[...map.values()].sort((a,b)=>totalTokens(b.tokens)-totalTokens(a.tokens));
  if(groups.length<=200)return groups;
  // Preserve all totals/purposes when grouping exceeds the display bound.
  const head=groups.slice(0,196),tail=groups.slice(196);
  for(const purpose of ["communication","execution","mixed","unknown"] as const){
   const rest=tail.filter(x=>x.purpose===purpose);if(!rest.length)continue;
   head.push({id:`other-${purpose}`,head:null,workerId:null,taskId:null,purpose,tokens:rest.reduce((a,x)=>plusTokens(a,x.tokens),noTokens()),turns:rest.reduce((a,x)=>a+x.turns,0)});
  }
  return head;
 };
 return {since:records.length?Math.min(...records.map(r=>r.startedAt)):null,limited:ledger.limited,unreadable:ledger.unreadable,periods:{all:group(0),today:group(today.getTime()),'7d':group(week.getTime())}};
}
