// Persistence-read compatibility only: existing TokenFlow unknown-coverage policy stays intact.
import { expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BotStore } from '../../src/core/store/bot-store';
import { tokenFlowHistory } from '../../src/core/token-flow-history';
import type { Bot } from '../../src/core/bot';
import { tempDir } from '../helpers';

it.each([false,true])('inactive-head coverage is unknown until journal checkpoint, including a warm cache: %s',async warm=>{
  const root=tempDir('history-consumer'),folder=join(root,'partner-claude');mkdirSync(folder,{recursive:true});
  const file=join(folder,'subagents.json');
  const rows=[{id:'saved',description:'Worker',startedAt:1,status:'completed',steps:[],prompt:'PRIVATE',result:'PRIVATE',outputTokenCounters:{message:10}}];
  if(warm)writeFileSync(file,JSON.stringify(rows));
  const store=new BotStore(folder);store.loadList('subagents.json');
  const bot={id:'test',engine:'codex',profile:{storeDir:root},subagents:{list:[]},partner:null,tasks:{tasks:[]}} as unknown as Bot;
  try{
    if(warm)expect((await tokenFlowHistory(bot)).rows[0].outputTokens).toBe(10);
    rows[0].outputTokenCounters.message=20;store.commitWorkerHistory(rows);
    const pending=await tokenFlowHistory(bot);
    expect(pending.unreadable).toBe(true);expect(pending.rows).toEqual([]);
    expect(JSON.stringify(pending)).not.toContain('PRIVATE');
    await store.flushWorkerHistory();
    const saved=await tokenFlowHistory(bot);
    expect(saved.unreadable).toBe(false);expect(saved.rows[0].outputTokens).toBe(20);
    expect(JSON.stringify(saved)).not.toContain('PRIVATE');
  }finally{await store.closeWorkerHistory();rmSync(root,{recursive:true,force:true});}
});
