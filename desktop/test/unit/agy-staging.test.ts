import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const fake=vi.hoisted(()=>({heads:[] as any[]}));
vi.mock('../../src/core/agent/agy-capabilities',()=>({agyWorkerRuntimeEnabled:()=>true,agyMixedRuntimeEnabled:()=>false,agyPairAllowed:()=>false}));
vi.mock('../../src/core/agent/agy-acp',()=>({AgyAcpHead:class {
 running=false;pid=-1;completionDependencies=[];exited=Promise.resolve();answers:any[]=[];
 constructor(readonly config:any,readonly handlers:any){fake.heads.push(this);}
 start(){this.running=true;this.handlers.onItem({kind:'init',sessionId:this.config.sessionId});}
 send(){this.handlers.onItem({kind:'permission',requestId:'acp:1',tool:'botling_write_file',summary:'write allow-marker.txt = ALLOWED',input:{path:'allow-marker.txt',content:'ALLOWED'}});}
 answer(...args:any[]){this.answers.push(args);}
 interrupt(){return 'stopped';}
 async terminate(){this.running=false;return {killed:[],forced:false};}
},verifyAcpRuntime(){}}));
vi.mock('../../src/core/process/tree',async original=>({...await original<any>(),processTreeAdapter:()=>({spawn(){throw Error('No real processes in staging unit tests');}})}));
import {StagingController} from '../provider-validation/staging/controller';
import {until} from '../helpers';
const controllers:StagingController[]=[];
afterEach(async()=>{for(const c of controllers.splice(0))await c.close();fake.heads.length=0;});
function setup(check=()=>{}){const root=mkdtempSync(join(tmpdir(),'agy-staging-'));const c=new StagingController(root,'/never-spawned',check,()=>{});controllers.push(c);return c;}
it('opening staging creates no head and a failed preflight never starts a provider',()=>{
 const c=setup(()=>{throw Error('missing existing auth');});expect(fake.heads).toEqual([]);
 expect(()=>c.start('write')).toThrow('missing existing auth');expect(fake.heads).toEqual([]);
 expect(c.snapshot().started).toEqual([]);
});
it('uses the production approval card and exact Bot.choose callback without auto-approval',async()=>{
 const c=setup();c.start('write');await until(()=>c.snapshot().chat.messages.some(m=>m.approval));
 const card=c.snapshot().chat.messages.find(m=>m.approval)!;
 expect(card.choices?.map(x=>x.label)).toEqual(['Allow once',"Don't allow"]);
 expect(fake.heads[0].answers).toEqual([]);
 expect(()=>c.choose('foreign-message',0)).toThrow('No current');expect(fake.heads[0].answers).toEqual([]);
 // Synthetic unit action only; never counted as real-user live acceptance.
 expect(c.choose(card.id,1)).toMatchObject({accepted:true});expect(fake.heads[0].answers[0]).toEqual(['acp:1',false,{path:'allow-marker.txt',content:'ALLOWED'},'The user did not allow it.']);
 expect(()=>c.choose(card.id,0)).toThrow('No current');
});
it('routes an explicit unit-test choice through exact production approval input',async()=>{
 const c=setup();c.start('write');await until(()=>c.snapshot().chat.messages.some(m=>m.approval));const card=c.snapshot().chat.messages.find(m=>m.approval)!;
 c.choose(card.id,0);expect(fake.heads[0].answers[0]).toEqual(['acp:1',true,{path:'allow-marker.txt',content:'ALLOWED'},undefined]);
 expect(c.snapshot().marker).toBe(null); // no real provider/file action, not live acceptance
});

it('limits each isolated runner to one case and shutdown is idempotent',async()=>{
 const c=setup();c.start('write');await until(()=>fake.heads.length>0);
 expect(()=>c.start('command')).toThrow('Case unavailable');
 const stop=c.close();expect(c.close()).toBe(stop);await stop;
 expect(c.snapshot().closed).toBe(true);expect(fake.heads[0].running).toBe(false);
 expect(()=>c.start('command')).toThrow('Case unavailable');
});
