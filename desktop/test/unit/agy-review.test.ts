import {expect,it} from 'vitest';
import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {AgyHead,AgyStream} from '../../src/core/agent/agy';
import {tempDir} from '../helpers';
it('never submits a task or starts a child without a pre-execution policy barrier',async()=>{
 const cwd=tempDir('agy-race'),marker=join(cwd,'executed'),script=join(cwd,'race.mjs');
 writeFileSync(script,`import fs from 'node:fs';import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){console.log(JSON.stringify({event:'init',conversation_id:'session',init:{permission_mode:'always-proceed'}}));fs.writeFileSync(${JSON.stringify(marker)},line);process.exit(0);}`);
 const head=new AgyHead({command:process.execPath,prefixArgs:[script],cwd,sessionId:'session',resume:false},{onItem(){},onExit(){}});
 try {head.start();head.send('REAL TASK','id');await head.exited;}catch{}finally{await head.terminate(50);}
 expect(existsSync(marker)).toBe(false);expect(head.pid).toBe(-1);
});
it('rejects SUCCESS before init',()=>{expect(()=>new AgyStream().parse(JSON.stringify({event:'result',result:{status:'SUCCESS'}}))).toThrow();});
it('recognizes strict as review-protected without granting execution authority',()=>{expect(new AgyStream().parse(JSON.stringify({event:'init',conversation_id:'session',init:{permission_mode:'strict'}}))).toEqual([{kind:'init',sessionId:'session'}]);});
it('cannot recover a rejected init into success',()=>{const s=new AgyStream();expect(()=>s.parse(JSON.stringify({event:'init',conversation_id:'session',init:{permission_mode:'always-proceed'}}))).toThrow();expect(()=>s.parse(JSON.stringify({event:'result',result:{status:'SUCCESS'}}))).toThrow();});
