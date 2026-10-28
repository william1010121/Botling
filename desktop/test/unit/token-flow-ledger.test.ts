import { expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { TokenFlowLedger, meteredPurpose, type MeteredTurn } from "../../src/core/token-flow-ledger";
const turn = (overrides: Partial<MeteredTurn> = {}): MeteredTurn => ({ botId: "stable-bot", head: "codex", threadId: "chat-one", turnId: "t1", workerId: null, run: null, parentThreadId: null, taskId: null, startedAt: Date.UTC(2026,9,28,23,59), endedAt: Date.UTC(2026,9,29,0,1), source: "provider-turn", scope: "exclusive", tokens: { input: 60, output: 20, cacheRead: 40, cacheWrite: 0 }, activities: ["execution"], complete: true, ...overrides });
it("persists identified chats and workers across restart/day rollover, deduplicates replay and never joins by name", () => {
 const file=join(tempDir("flow-ledger"),"usage.jsonl"); let ledger=new TokenFlowLedger(file);
 const a=turn(), b=turn({ threadId:"chat-two", turnId:"t2", endedAt:Date.UTC(2026,9,30), workerId:"worker",run:2,activities:["coordination"] });
 expect(ledger.record(a)).toBe(true); ledger.record(b); ledger=new TokenFlowLedger(file); ledger.record(a);
 ledger.record({...a,startedAt:a.startedAt+86400000,endedAt:a.endedAt+86400000});
 expect([...ledger.records.values()][0].endedAt).toBe(a.endedAt);
 expect(meteredPurpose([...ledger.records.values()][0])).toBe("execution");
 expect(ledger.records.size).toBe(2); expect([...ledger.totals("stable-bot").values()].map(x=>x.output)).toEqual([20,20]);
 expect(ledger.totals("replacement-same-name").size).toBe(0);
 expect(meteredPurpose(a)).toBe("execution");expect(meteredPurpose(b)).toBe("communication");
 expect(meteredPurpose(turn({activities:["coordination","execution"]}))).toBe("mixed");
 expect(meteredPurpose(turn({complete:false}))).toBe("unknown");
 expect(meteredPurpose(turn({activities:[]}))).toBe("unknown");
 ledger.record(turn({tokens:{input:60,output:30,cacheRead:40,cacheWrite:0}}));
 ledger=new TokenFlowLedger(file);expect(ledger.records.size).toBe(2);expect(meteredPurpose([...ledger.records.values()][0])).toBe("unknown");
 expect([...ledger.totals("stable-bot").values()][0]).toEqual({input:60,output:20,cacheRead:40,cacheWrite:0});
});

it("summarizes all historical metered chats and workers without dropping totals at display retention", async()=>{
 const { meteredSummary } = await import("../../src/core/token-flow-summary");
 const ledger=new TokenFlowLedger(join(tempDir("flow-summary"),"usage.jsonl"));
 const now=Date.UTC(2026,9,30,12);
 for(let i=0;i<240;i++)ledger.records.set(String(i),turn({threadId:`chat-${i}`,endedAt:now,activities:i%2?["coordination"]:["execution"]}));
 ledger.records.set("old",turn({threadId:"old-chat",endedAt:Date.UTC(2026,8,1),activities:[]}));
 const snapshot=meteredSummary(ledger,"stable-bot",now);
 expect(snapshot.periods.all.length).toBeLessThanOrEqual(200);
 expect(snapshot.periods.all.reduce((n,g)=>n+g.tokens.output,0)).toBe(4820);
 expect(snapshot.periods.today.reduce((n,g)=>n+g.tokens.output,0)).toBe(4800);
 expect(snapshot.periods.all.filter(g=>g.purpose==="communication").reduce((n,g)=>n+g.tokens.output,0)).toBe(2400);
});
