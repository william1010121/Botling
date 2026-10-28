import { expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BotStore } from '../../src/core/store/bot-store';
import { readHistory } from '../../src/core/durable/history-journal';
import { tempDir } from '../helpers';

it.each([false, true])('recovers removal/readdition at every checkpoint/prune crash boundary (readd=%s)', async readd => {
  const root=tempDir('history-crash-generation'), file=join(root,'subagents.json');
  const old={id:'old',result:'unchanged historical report'}, active={id:'active',n:0};
  writeFileSync(file,JSON.stringify([old,active]));
  const store=new BotStore(root);store.loadList('subagents.json');
  try {
    active.n=1;store.commitWorkerHistory([old,active],new Set(['active']));
    store.commitWorkerHistory([active],new Set()); // normal trim: old has no patch
    const expected=readd?[{id:'old',result:'new incarnation'},active]:[active];
    if(readd)store.commitWorkerHistory(expected);
    const names=readdirSync(file+'.journal').filter(n=>n.endsWith('.json')).sort();
    const entries=names.map(name=>({name,bytes:readFileSync(join(file+'.journal',name))}));
    const before=readFileSync(file);
    expect(readHistory(file)).toEqual(expected); // receipt survives without checkpoint
    await store.closeWorkerHistory();
    const after=readFileSync(file);
    // Prior checkpoint + all receipts (rename not durable), then committed checkpoint with
    // every possible subset left by pruning. No assumptions about directory deletion order.
    for(let mask=-1;mask<(1<<entries.length);mask++) {
      const image=join(root,`image-${mask}`);mkdirSync(image);
      const target=join(image,'subagents.json');writeFileSync(target,mask===-1?before:after);
      mkdirSync(target+'.journal');
      entries.forEach((entry,index)=>{if(mask===-1||(mask&(1<<index)))writeFileSync(join(target+'.journal',entry.name),entry.bytes);});
      expect(readHistory(target),`crash image ${mask}`).toEqual(expected);
      // Reopen and append beyond the checkpoint watermark, including when no receipts remain.
      const reopened=new BotStore(image);reopened.loadList('subagents.json');
      const next=[...expected,{id:'after-restart',result:'durable'}];
      reopened.commitWorkerHistory(next);expect(readHistory(target)).toEqual(next);
      await reopened.closeWorkerHistory();expect(readHistory(target)).toEqual(next);
    }
  } finally { await store.closeWorkerHistory();rmSync(root,{recursive:true,force:true}); }
});

it('fails closed when an uncovered receipt is missing instead of accepting a later absolute patch',async()=>{
  const root=tempDir('history-receipt-gap'),file=join(root,'subagents.json');
  writeFileSync(file,'[]');const store=new BotStore(root);store.loadList('subagents.json');
  let removed:string|undefined,bytes:Buffer|undefined;
  try{
    store.commitWorkerHistory([{id:'active',n:0}]);await store.flushWorkerHistory();
    store.commitWorkerHistory([{id:'active',n:1}]);store.commitWorkerHistory([{id:'active',n:2}]);
    removed=join(file+'.journal',readdirSync(file+'.journal').filter(n=>n.endsWith('.json')).sort()[0]);
    bytes=readFileSync(removed);rmSync(removed);
    expect(()=>readHistory(file)).toThrow('sequence gap');
    await expect(store.flushWorkerHistory()).rejects.toThrow('sequence gap');
    writeFileSync(removed,bytes);removed=undefined;
    await store.flushWorkerHistory();expect(readHistory(file)).toEqual([{id:'active',n:2}]);
  }finally{if(removed&&bytes)writeFileSync(removed,bytes);await store.closeWorkerHistory();rmSync(root,{recursive:true,force:true});}
});
