// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect,it,vi } from "vitest";
import { TokenFlowGraph } from "../../src/renderer/TokenFlowGraph";
import { forwardRows,forwardTasks,forwardWorkers } from "../fixtures/token-flow/forward-data";
it("shows verified ownership instead of Mixed/Unknown purposes; expands task streams, highlights paths, and exposes parent and cache evidence",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 try{
  await act(async()=>root.render(createElement(TokenFlowGraph,{name:"Fixture project",rows:forwardRows,tasks:forwardTasks,workers:forwardWorkers})));
  expect(host.textContent).not.toContain("Mixed");expect(host.querySelectorAll('.tf-topology-activity')).toHaveLength(4);
  expect(host.textContent).toContain("Chat / no task");expect(host.textContent).toContain("Earlier / retained attribution");expect(host.textContent).toContain("Missing dispatch context");
  const expand=host.querySelector<HTMLButtonElement>('[aria-label="Expand Reliable Token Flow"]')!;
  await act(async()=>expand.click());expect(expand.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelectorAll('.tf-topology-measurement')).toHaveLength(2);
  expect(host.querySelectorAll('path[data-related=false]').length).toBeGreaterThan(0);
  await act(async()=>host.querySelectorAll<HTMLButtonElement>('.tf-topology-measurement')[1].click());
  const detail=host.querySelector('[aria-label="Measurement evidence"]')!;
  expect(detail.textContent).toContain("parent-thread");expect(detail.textContent).toContain("worker-thread");expect(detail.textContent).toContain("worker-1");expect(detail.textContent).toContain("42,000");
  const scrollTo=vi.fn();Object.defineProperty(host.querySelector('.tf-topology-viewport'),'scrollTo',{value:scrollTo});
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Agents')!.click());expect(scrollTo).toHaveBeenCalledWith({left:700,top:0});
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Collapse all')!.click());expect(host.querySelectorAll('.tf-topology-measurement')).toHaveLength(0);
 }finally{await act(async()=>root.unmount());host.remove();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;}
});

import { TokenFlow } from "../../src/renderer/TokenFlow";
it.each(["limited","unreadable"])("shows an actionable collection-stopped state for %s storage",async flag=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 Object.defineProperty(document,"hidden",{configurable:true,value:false});
 const host=document.createElement("div"),root=createRoot(host);
 const bot:any={id:"bot",name:"Project",subagentRows:[],delegationRows:[]};
 const history:any={rows:[],tasks:[],metered:{limited:false,unreadable:false,[flag]:true,error:"Token storage I/O failed (ENOSPC).",periods:{all:[],today:[],"7d":[]}}};
 const client:any={request:async(r:any)=>r.type==="tokenFlow.view"?history:{tokens:{input:0,output:0,cacheRead:0,cacheWrite:0}},onEvent:()=>()=>{}};
 try{
  await act(async()=>root.render(createElement(TokenFlow,{client,bot,bots:[bot],tasks:[]})));
  expect(host.querySelector(".tf-status")?.textContent).toBe("Collection stopped");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("ENOSPC");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Check disk space");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Displayed totals are incomplete");
 }finally{await act(async()=>root.unmount());(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;}
});
