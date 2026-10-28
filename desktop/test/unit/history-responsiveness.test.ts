// One bounded 91.79 MiB fixture, matching the investigated history size. No live data.
import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { decodeHistoryCheckpoint } from "../../src/core/durable/history-journal";
import { BotStore } from "../../src/core/store/bot-store";
import { ComposerRequests } from "../../src/renderer/chat-frame/composer-requests";
import { tempDir } from "../helpers";

it('accepts a durable message while a large history checkpoint is running without blocking the shared event loop', async () => {
  const base=process.env.BOTLING_PERSISTENCE_MEASURE_ROOT;
  if(base)mkdirSync(base,{recursive:true});
  const root=base?mkdtempSync(join(base,'run-')):tempDir('history-responsiveness');
  const file=join(root,'subagents.json'),store=new BotStore(root),chat=new BotStore(join(root,'chat'));
  let pulse:ReturnType<typeof setInterval>|undefined;
  try{
    const target=96_245_933;
    const seed=Array.from({length:384},(_,i)=>({id:`worker-${i}`,status:i===383?'running':'completed',steps:[] as {id:string;text:string}[],result:''}));
    const remaining=target-Buffer.byteLength(JSON.stringify(seed));
    for(let i=0;i<seed.length;i++)seed[i].result='x'.repeat(Math.floor(remaining/seed.length)+(i<remaining%seed.length?1:0));
    writeFileSync(file,JSON.stringify(seed));expect(statSync(file).size).toBe(target);
    const rows=store.loadList('subagents.json') as typeof seed;
    const current=rows.at(-1)!;
    current.steps.push({id:'first',text:'checkpoint me'});
    store.commitWorkerHistory(rows,new Set([current.id]));
    let checkpointDone=false;
    let last=performance.now(),maxGap=0,ticks=0;
    pulse=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;},5);
    const checkpoint=store.flushWorkerHistory().then(()=>{checkpointDone=true;});
    let requestAt=0,coreAt=0,durableAt=0,ackAt=0,commitMs=0,ackBeforeCheckpoint=false;
    const transport=new ComposerRequests(action=>{
      setImmediate(()=>{
        coreAt=performance.now();
        current.steps.push({id:'second',text:'arrived during checkpoint'});
        const start=performance.now();store.commitWorkerHistory(rows,new Set([current.id]));commitMs=performance.now()-start;
        chat.saveMessages([{id:'message',role:'user',text:'accepted synthetic message',date:0}]);
        durableAt=performance.now();
        setImmediate(()=>{ackAt=performance.now();ackBeforeCheckpoint=!checkpointDone;transport.response(action.requestID as string,{ok:true});});
      });return true;
    },()=>{});
    requestAt=performance.now();await transport.request({type:'send',botID:'synthetic',text:'accepted synthetic message'});
    const journalBytes=readdirSync(file+'.journal').filter(n=>n.endsWith('.json')).reduce((total,n)=>total+statSync(join(file+'.journal',n)).size,0);
    await checkpoint;await store.flushWorkerHistory();
    clearInterval(pulse);pulse=undefined;
    const metrics={historyBytes:target,commitMs,requestToCoreMs:coreAt-requestAt,coreToDurableMs:durableAt-coreAt,requestToAckMs:ackAt-requestAt,maxHeartbeatGapMs:maxGap,heartbeatTicks:ticks,ackBeforeCheckpoint,journalBytes};
    console.log('HISTORY_RESPONSIVENESS',JSON.stringify(metrics));
    if(base)writeFileSync(join(base,'results.json'),JSON.stringify(metrics,null,2));
    expect(ackBeforeCheckpoint).toBe(true);
    expect(ticks).toBeGreaterThan(3);
    // The old isolated full rewrite blocked for 800–1895ms. This guards the interaction budget,
    // allowing ample filesystem/scheduler variation without asserting a microbenchmark speedup.
    expect(commitMs).toBeLessThan(350);
    expect(ackAt-requestAt).toBeLessThan(350);
    expect(maxGap).toBeLessThan(350);
    const recovered=decodeHistoryCheckpoint(JSON.parse(readFileSync(file,"utf8"))).rows;
    expect(recovered).toHaveLength(384);
    expect(recovered.at(-1)!.steps).toEqual(current.steps);
    expect(recovered[0].result).toBe(rows[0].result);
    expect(JSON.parse(readFileSync(join(root,'chat/chat.json'),'utf8'))[0].text).toBe('accepted synthetic message');
  }finally{
    if(pulse)clearInterval(pulse);
    await store.closeWorkerHistory();
    rmSync(root,{recursive:true,force:true});
  }
},30_000);
