import {afterEach,expect,it} from 'vitest';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Bot} from '../../src/core/bot';
import {botPrompts} from '../../src/core/prompts';
import {ProcessLedger} from '../../src/core/process/ledger';
import {mainProfile} from '../../src/core/store/workspace';
import {tempDir,until} from '../helpers';
const bots:Bot[]=[];
afterEach(async()=>{for(const b of bots.splice(0))await b.shutdown({tidy:false});});
const session='11111111-2222-4333-8444-555555555555';
function harness(){
 const dir=tempDir('agy-recovery'),profile=mainProfile(dir),launches:any[]=[],events:any[]=[];
 mkdirSync(profile.storeDir,{recursive:true});const settings=join(profile.storeDir,'bot.json');
 writeFileSync(settings,JSON.stringify({engine:'agy',heads:{engines:['agy'],answerWith:'agy'},agyConversation:session}));
 const make=()=>{const b=new Bot({profile,deferStartup:true,welcome:false,ledger:new ProcessLedger(join(dir,'ledger.json')),headConfig(){throw Error('No other agent');},agyConfig(_p,c){launches.push(c);return c;},prompts:()=>botPrompts({profile,engine:'agy'}),emit:e=>events.push(e),log(){},approvalTimeoutMs:100,idleMs:60000,interruptGraceMs:10});bots.push(b);return b;};
 const say=async(b:Bot)=>{const {turnId}=b.send('explicit next message');await until(()=>events.some(e=>e.type==='turn.finished'&&e.turnId===turnId));};
 return {make,launches,events,say,saved:()=>JSON.parse(readFileSync(settings,'utf8'))};
}
it('preserves failed resume identity and recovery across next message and restart',async()=>{
 const h=harness(),b=h.make(),head={pid:-1,running:false};(b as any).head=head;
 (b as any).onExit(head,{code:1,signal:null,stderr:'resume failed',expected:false,silent:true});
 expect(h.saved()).toMatchObject({agyConversation:session,agyRecovery:{sessionId:session,state:'resume-required'}});
 await h.say(b);expect(h.launches).toHaveLength(1);expect(h.launches[0]).toMatchObject({sessionId:session,resume:true});
 await b.shutdown({tidy:false});await h.say(h.make());expect(h.launches).toHaveLength(2);expect(h.launches[1]).toMatchObject({sessionId:session,resume:true});
 expect(h.saved()).toMatchObject({agyConversation:session,agyRecovery:{state:'resume-required'}});
});
it('refuses engine selection and clears identity only on intentional new-session',async()=>{
 const h=harness(),b=h.make();await expect(b.setHeads(['agy'])).rejects.toThrow('pre-task policy barrier');
 (b as any).newSession();expect(h.saved().agyConversation).toBeUndefined();expect(h.saved().agyRecovery).toBeUndefined();
});
it('never imports persistent allow rules into ACP approval cards',async()=>{
 const h=harness(),b=h.make(),answers:any[]=[];
 (b as any).alwaysAllowed=['Antigravity tool'];
 const head={running:true,answer:(...args:any[])=>answers.push(args)};
 (b as any).ask(head,{kind:'permission',requestId:'acp:7',tool:'Antigravity tool',summary:'write a file',input:{}},null);
 expect(answers).toEqual([]);
 const card=(b as any).records.findLast((r:any)=>r.permissionTool==='Antigravity tool');
 expect(card.choices.map((c:any)=>c.action)).toEqual(['allowOnce','deny']);
 b.choose(card.id,1);expect(answers[0][1]).toBe(false);
});

it('engine switching retains agy identity; only an intentional new chat clears it',()=>{
 const h=harness(),b=h.make();(b as any).becomeEngine('codex');expect(h.saved().agyConversation).toBe(session);
 (b as any).becomeEngine('agy');expect((b as any).session).toMatchObject({sessionId:session,started:true});
 (b as any).newSession();expect(h.saved().agyConversation).toBeUndefined();
});
