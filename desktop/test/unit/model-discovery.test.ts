import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { discoverModels, normalizeModels, modelDiscoveryService } from '../../src/core/agent/model-discovery';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(mode: string) {
 const dir=mkdtempSync(join(tmpdir(),'models-test-'));dirs.push(dir);const file=join(dir,'engine.cjs'),log=join(dir,'requests');
 writeFileSync(file, `
const fs=require('fs'),mode=${JSON.stringify(mode)},log=${JSON.stringify(log)};
if(process.argv.includes('auth')) {console.log(JSON.stringify({loggedIn:mode!=='signedout'}));process.exit(0)}
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(log,line+'\\n');
 const send=result=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
 if(mode==='timeout') return;if(mode==='exit') process.exit(1);
 if(m.type==='control_request') {console.log(JSON.stringify({type:'control_response',response:{request_id:m.request_id,subtype:'success',response:mode==='unsupported'?{}:{models:[{value:'new-claude',displayName:'New Claude'}]}}}));return}
 if(m.method==='initialize') send({protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.3'}});
 if(m.method==='account/read') send({account:mode==='signedout'?null:{type:'apiKey'},requiresOpenaiAuth:true});
 if(m.method==='model/list') {if(mode==='error') console.log(JSON.stringify({id:m.id,error:{code:-32601,message:'SECRET'}}));else send({data:[{id:'internal-id',model:m.params.cursor?'second':'first',displayName:'Model'}],nextCursor:m.params.cursor?null:'next'})}
 if(m.method==='session/new') {if(mode==='signedout') console.log(JSON.stringify({id:m.id,error:{code:-32000,message:'SECRET auth URL'}}));else send(mode==='unsupported'?{}:{sessionId:'discovery',models:{currentModelId:'agy-model',availableModels:[{modelId:'agy-model',name:'AGY Model'}]}})}
});`);
 return {command:{file:process.execPath,prefixArgs:[file]},requests:()=>{try{return readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s));}catch{return [];}}};
}
it('normalizes provider IDs, rejects invalid IDs, removes hidden and duplicate choices',()=>{
 expect(normalizeModels('codex',[{id:'opaque',model:'slug',displayName:'Nice',supportedReasoningEfforts:[{reasoningEffort:'high'}]},{id:'duplicate',model:'slug'},{id:'hidden',hidden:true},{id:'bad\nID'}])).toEqual([{id:'slug',name:'Nice',isDefault:false,efforts:['high']}]);
 expect(normalizeModels('claude',[{value:'default'}])[0]?.isDefault).toBe(true);
 expect(normalizeModels('agy',[{modelId:'m'}],'m')[0]?.isDefault).toBe(true);
});
it('Claude initializes without user content and reports unsupported catalogs',async()=>{
 const f=fixture('ready');expect((await discoverModels('claude',f.command)).models[0]?.id).toBe('new-claude');
 expect(f.requests()).toEqual([{type:'control_request',request_id:'models',request:{subtype:'initialize'}}]);
 expect((await discoverModels('claude',fixture('unsupported').command)).status).toBe('unsupported');
});
it('Codex awaits initialize, checks auth and follows pagination using model slugs',async()=>{
 const f=fixture('ready');const r=await discoverModels('codex',f.command);expect(r.status).toBe('ready');expect(r.models.map(m=>m.id)).toEqual(['first','second']);
 expect(f.requests().map(m=>m.method)).toEqual(['initialize','initialized','account/read','model/list','model/list']);
});
it.each(['claude','codex'] as const)('%s reports signed out without starting a turn',async engine=>{
 const f=fixture('signedout');expect((await discoverModels(engine,f.command)).status).toBe('signed-out');
 expect(f.requests().some(m=>/turn|prompt|login|authenticate/.test(m.method??''))).toBe(false);
});
it('reports missing runtime, timeout, exit and unsupported RPC without leaking diagnostics',async()=>{
 expect((await discoverModels('codex',{file:'/not/a/runtime'})).status).toBe('unavailable');
 expect((await discoverModels('codex',fixture('timeout').command,80)).status).toBe('error');
 expect((await discoverModels('codex',fixture('exit').command)).status).toBe('error');
 const r=await discoverModels('codex',fixture('error').command);expect(r.status).toBe('unsupported');expect(JSON.stringify(r)).not.toContain('SECRET');
});
it('shares only concurrent requests; refresh does not retain old catalogs',async()=>{
 let calls=0;const service=modelDiscoveryService(async()=>{calls++;return {status:'ready',models:[],message:'',source:''};});
 await Promise.all([service('codex','bot'),service('codex','bot')]);expect(calls).toBe(1);await service('codex','bot');expect(calls).toBe(2);
});
it('ACP advertises models without prompt, tools, authentication or persisted conversations',async()=>{
 const f=fixture('ready');const r=await discoverModels('agy',f.command);expect(r.models).toEqual([{id:'agy-model',name:'AGY Model',isDefault:true,efforts:null}]);
 expect(f.requests().map(m=>m.method)).toEqual(['initialize','session/new']);expect(f.requests()[1].params.mcpServers).toEqual([]);expect(f.requests()[1].params._meta.antigravity.enabledTools).toEqual([]);
 expect((await discoverModels('agy',fixture('signedout').command)).status).toBe('signed-out');expect((await discoverModels('agy',fixture('unsupported').command)).status).toBe('unsupported');
});
