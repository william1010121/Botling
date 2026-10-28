import { expect,it } from "vitest";
import { TokenFlowMeter } from "../../src/core/token-flow-meter";
import { meteredPurpose } from "../../src/core/token-flow-ledger";
it("attributes whole metered turns by structured activity, including worker coordination and mixed work",()=>{
 const m=new TokenFlowMeter();m.fresh("main");m.fresh("worker");
 for(const [thread,activities] of [["main",[{type:"commandExecution"}]],["worker",[{type:"dynamicToolCall",tool:"app_send_message"}]]] as const){
  m.begin(thread,"t");for(const item of activities)m.observe("item/started",{threadId:thread,turnId:"t",item});
  m.observe("thread/tokenUsage/updated",{threadId:thread,tokenUsage:{total:{inputTokens:100,cachedInputTokens:40,outputTokens:20}}});
  const r=m.finish(thread,"t")!;expect(r.tokens).toEqual({input:60,cacheRead:40,output:20,cacheWrite:0});expect(meteredPurpose(r)).toBe(thread==="main"?"execution":"communication");expect(m.finish(thread,"t")).toBeNull();
 }
 m.begin("main","t2");m.coordination("main");m.observe("item/started",{threadId:"main",item:{type:"fileChange"}});m.observe("thread/tokenUsage/updated",{threadId:"main",tokenUsage:{total:{inputTokens:200,cachedInputTokens:80,outputTokens:40}}});expect(meteredPurpose(m.finish("main","t2")!)).toBe("mixed");
 // Resumed lifetime total has no trustworthy starting point; next interval does.
 const resumed=new TokenFlowMeter();resumed.begin("past","first");resumed.observe("thread/tokenUsage/updated",{threadId:"past",tokenUsage:{total:{inputTokens:900,outputTokens:100}}});expect(resumed.finish("past","first")).toBeNull();
 resumed.begin("past","next");resumed.observe("thread/tokenUsage/updated",{threadId:"past",tokenUsage:{total:{inputTokens:910,outputTokens:105}}});const r=resumed.finish("past","next")!;expect(r.tokens.output).toBe(5);expect(meteredPurpose(r)).toBe("unknown");
});

it.each([false,true])("invalidates an abandoned turn even with intermediate usage=%s, then recovers", intermediate => {
 const m=new TokenFlowMeter();m.fresh("thread");m.begin("thread","abandoned");m.coordination("thread");
 if(intermediate)m.observe("thread/tokenUsage/updated",{threadId:"thread",turnId:"abandoned",tokenUsage:{total:{inputTokens:100,outputTokens:20}}});
 // Cancellation/error may omit turn/completed. An intermediate update is not its final boundary.
 m.begin("thread","replacement");m.observe("item/started",{threadId:"thread",turnId:"replacement",item:{type:"commandExecution"}});
 m.observe("thread/tokenUsage/updated",{threadId:"thread",turnId:"replacement",tokenUsage:{total:{inputTokens:110,outputTokens:25}}});
 expect(m.finish("thread","replacement")).toBeNull();
 m.begin("thread","recovered");m.observe("thread/tokenUsage/updated",{threadId:"thread",turnId:"recovered",tokenUsage:{total:{inputTokens:120,outputTokens:30}}});
 expect(m.finish("thread","recovered")?.tokens).toEqual({input:10,output:5,cacheRead:0,cacheWrite:0});
});
