import React from "react";
import { createRoot } from "react-dom/client";
import { TokenFlow } from "../../../src/renderer/TokenFlow";
import { forwardRows, forwardTasks, forwardWorkers } from "./forward-data";
const bot:any={id:"fixture-project",name:"Token Flow",heads:["claude","codex"],subagentRows:[],delegationRows:forwardWorkers};
const history:any={botId:bot.id,asOf:Date.now(),limited:true,unreadable:false,rows:forwardWorkers,tasks:forwardTasks,metered:{since:Date.now(),limited:false,unreadable:false,periods:{all:forwardRows,today:forwardRows,"7d":forwardRows}}};
const client:any={request:async(r:any)=>r.type==="tokenFlow.view"?history:{day:"Today",tokens:{input:0,output:0,cacheRead:0,cacheWrite:0}},onEvent:()=>()=>{}};
createRoot(document.getElementById("root")!).render(<TokenFlow client={client} bot={bot} bots={[bot]} tasks={[]} />);
