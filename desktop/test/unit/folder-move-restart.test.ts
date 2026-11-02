// A bot whose session folder moved (a plugin's `sessions.folder`, spec/models/folders) restarts in the new
// folder before your next message, once; while its own work runs your message waits for it, never going to
// the process still in the old folder (TurnStartsCurrent).
import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const fixture=vi.hoisted(()=>{
 const heads:any[]=[];
 class Head {
  running=false;pid=0;exited=Promise.resolve();completionDependencies:any[]=[];sent:string[]=[];stops=0;
  constructor(readonly config:any,readonly handlers:any){heads.push(this);}
  start(){this.running=true;queueMicrotask(()=>this.handlers.onItem({kind:'init',sessionId:this.config.sessionId}));}
  send(text:string){this.sent.push(text);}
  steer(text:string){this.sent.push(text);return true;}
  endTurn(){this.handlers.onItem({kind:'result',ok:true,text:'Finished',subtype:'end_turn'});}
  finish(){this.stops++;this.running=false;this.handlers.onExit({code:0,signal:null,stderr:'',expected:true,silent:false});}
  async terminate(){this.finish();return {killed:[],forced:false};}
 }
 return {heads,Head};
});
vi.mock('../../src/core/agent/head',async original=>({...await original<any>(),ClaudeHead:class extends fixture.Head{}}));
import {Bot} from '../../src/core/bot';
import {mainProfile} from '../../src/core/store/workspace';
import {botPrompts} from '../../src/core/prompts';
import {tempDir,until} from '../helpers';
const bots:Bot[]=[];
afterEach(async()=>{for(const b of bots.splice(0))await b.shutdown({tidy:false});fixture.heads.length=0;});
const MOVED={told:'your working folder changed; see the note at your wake',shown:'Working folder changed.'};
function make(){
 const folder=tempDir('folder-move'),profile=mainProfile(folder);mkdirSync(profile.storeDir,{recursive:true});
 writeFileSync(join(profile.storeDir,'bot.json'),JSON.stringify({engine:'claude',model:'opus',heads:{engines:['claude'],answerWith:'claude'}}));
 const where={tree:null as null|{cwd:string;addDirs:string[]}};
 const b=new Bot({profile,deferStartup:true,ledger:{record(){},forget(){}} as any,
  headConfig(_p,c){return {...c,command:'/never-spawn',cwd:folder,allowedTools:[]};},
  prompts:(engine,heads)=>botPrompts({profile,engine,heads}),emit(){},log(){},idleMs:600000,approvalTimeoutMs:1000,interruptGraceMs:10,
  worktree:()=>where.tree});
 bots.push(b);return {b,folder,where};
}
const settle=()=>new Promise(r=>setImmediate(r));
const texts=(b:Bot)=>b.snapshot().messages.map((m:any)=>m.text);
function busy(b:Bot){return vi.spyOn((b as any).subagents,'running','get').mockReturnValue([{id:'active-worker',background:true,status:'running'}]);}
async function idleFirstTurn(b:Bot){b.send('first');await until(()=>fixture.heads[0]?.sent.length);const first=fixture.heads[0];first.endTurn();await settle();return first;}

it('a move restarts the awake bot in the new folder before its next message, once',async()=>{
 const {b,folder,where}=make();const first=await idleFirstTurn(b);
 expect(first.config.cwd).toBe(folder);
 where.tree={cwd:'/w/site-fix',addDirs:[]};b.folderMoved(MOVED);
 b.send('next');await until(()=>fixture.heads[1]?.sent.length);
 expect(first.stops).toBe(1);expect(fixture.heads[1].config.cwd).toBe('/w/site-fix');
 expect(texts(b)).toContain('Restarted → Working folder changed.');
 fixture.heads[1].endTurn();await settle();
 b.send('again');await until(()=>fixture.heads[1].sent.length===2);
 expect(fixture.heads).toHaveLength(2);expect(fixture.heads[1].stops).toBe(0);
});

it('while its own work runs, your message waits for it and then goes to the new folder, never to the old process',async()=>{
 const {b,folder,where}=make();const first=await idleFirstTurn(b);const spy=busy(b);
 try {
  where.tree={cwd:'/w/site-fix',addDirs:[]};b.folderMoved(MOVED);
  b.send('next');await settle();await settle();
  expect(first.sent).toHaveLength(1);expect(first.stops).toBe(0);
  expect(texts(b).join('\n')).toContain('waiting for active work');
 } finally {spy.mockRestore();}
 (b as any).checkSettingsHold();
 await until(()=>fixture.heads[1]?.sent.length);
 expect(first.config.cwd).toBe(folder);
 expect(fixture.heads[1].config.cwd).toBe('/w/site-fix');expect(fixture.heads[1].sent.at(-1)).toContain('next');
 expect(texts(b).join('\n')).not.toContain('waiting for active work');
});

it('asleep, a move costs no restart: the next wake starts in the new folder',async()=>{
 const {b,where}=make();
 where.tree={cwd:'/w/site-fix',addDirs:[]};b.folderMoved(MOVED);
 b.send('first');await until(()=>fixture.heads[0]?.sent.length);
 expect(fixture.heads[0].config.cwd).toBe('/w/site-fix');expect(fixture.heads[0].stops).toBe(0);
 expect(texts(b).join('\n')).not.toContain('Restarted');
});
