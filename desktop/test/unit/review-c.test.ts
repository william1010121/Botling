import {afterEach,expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {SWAP_SCRIPT,recoverUpdates} from '../../src/main/update-install';
import {directoryDefaults} from '../../src/main/main-environment';
import {blockingRecovery,commitUpdateReceipt} from '../../src/main/update-state';
import {tempDir,until} from '../helpers';
const cleanups:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();});
function fixture(){
 const base=tempDir('review-c'),target=join(base,'Botling 2.app'),root=join(base,'.botling-update-c'),data=join(base,'data');
 for(const p of [target,root,data])mkdirSync(p,{recursive:true});
 const staged=join(root,'Botling 2.app');mkdirSync(join(staged,'Contents/MacOS'),{recursive:true});
 writeFileSync(join(staged,'Contents/MacOS/TestApp'),`#!/bin/sh\nprintf candidate > '${data}/schema'\nexit 1\n`,{mode:0o755});
 writeFileSync(join(root,'download.zip'),'synthetic ZIP');writeFileSync(join(data,'schema'),'old-flushed');
 writeFileSync(join(root,'owner.json'),JSON.stringify({pid:99999999,target,dataDir:data,token:'c-token'}));
 writeFileSync(join(data,'update-pending.json'),JSON.stringify({root,target,token:'c-token',version:'2.0.1',executable:'TestApp'}));
 const opened=join(base,'opened');const open=join(base,'open');writeFileSync(open,`#!/bin/sh\nprintf '%s\\n' "$@" > '${opened}'\n`,{mode:0o755});
 cleanups.push(()=>rmSync(base,{recursive:true,force:true}));return{base,target,root,data,staged,opened,open};
}
async function swap(mode:'snapshot'|'restore'|'rm'|'env'|'cache'|'move-old'|'move-new'){
 const f=fixture();const ditto=join(f.base,'ditto'),rm=join(f.base,'rm'),mv=join(f.base,'mv');
 const fail=mode==='snapshot'?`case "$2" in '${f.root}/data-before'*) mkdir -p "$2"; echo partial > "$2/partial"; exit 1;; esac`: mode==='restore'||mode==='rm'?`case "$2" in '${f.data}'|'${f.data}.update-restore-'*) mkdir -p "$2"; echo partial > "$2/partial"; exit 1;; esac`:'';
 writeFileSync(ditto,`#!/bin/sh\n${fail}\nexec /usr/bin/ditto "$@"\n`,{mode:0o755});
 writeFileSync(rm,`#!/bin/sh\n${mode==='rm'?`for arg do case "$arg" in '${f.data}'|'${f.data}.update-restore-'*) exit 1;; esac; done`:''}\nexec /bin/rm "$@"\n`,{mode:0o755});
 writeFileSync(mv,`#!/bin/sh\n${mode==='move-old'?`[ "$1" != '${f.data}' ] || exit 1`:mode==='move-new'?`[ "$1" != '${f.data}.update-restore-c-token' ] || exit 1`:''}\nexec /bin/mv "$@"\n`,{mode:0o755});
 if(mode==='cache'){
  for(const dir of ['core/Cache','electron/Partitions/synthetic/Cache','electron/Partitions/synthetic/Local Storage']){mkdirSync(join(f.data,dir),{recursive:true});writeFileSync(join(f.data,dir,'content'),'persistent');}
 }
 if(mode==='cache')for(const name of ['Cache','Code Cache','GPUCache','Local Storage','IndexedDB','Cookies']){
  const dir=join(f.data,'electron',name);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'content'),name);
 }
 const script=join(f.root,'swap.sh');writeFileSync(script,SWAP_SCRIPT.replaceAll('/usr/bin/ditto',ditto).replaceAll('/bin/rm',rm).replaceAll('/bin/mv',mv).replaceAll('/usr/bin/open',f.open));
 const env={...process.env};if(mode==='env')for(const k of ['BOTLING_IMPORT_FROM','BOTLING_1X_DIR','CODEX_HOME','TMPDIR','CLAUDE_CONFIG_DIR'])delete env[k];
 const child=spawn('/bin/sh',[script,'99999999',f.target,f.staged,join(f.root,'previous.app'),join(f.root,'boot.ok'),'c-token','TestApp','0','0.02',f.data,'10','50'],{env,stdio:['ignore','ignore','pipe']});let errors='';child.stderr!.on('data',b=>errors+=b);
 cleanups.push(()=>{child.kill('SIGKILL');});const [code]=await once(child,'exit');return{...f,code};
}
it('C1 snapshot failure is reclaimable; no partial snapshot/stage/pending blocks the next update',async()=>{
 const f=await swap('snapshot');expect(f.code).toBe(18);await recoverUpdates(f.data,f.target);
 expect(readFileSync(join(f.data,'schema'),'utf8')).toBe('old-flushed');
 expect(readdirSync(f.base).filter(n=>n.startsWith('.botling-update-'))).toEqual([]);expect(existsSync(join(f.data,'update-pending.json'))).toBe(false);
});
it('C1 reclaims missing-root pending metadata even when the app was moved',async()=>{
 const f=fixture();rmSync(f.root,{recursive:true});await recoverUpdates(f.data,join(f.base,'Moved.app'));
 expect(existsSync(join(f.data,'update-pending.json'))).toBe(false);
});
it('C1 excludes only regenerable Chromium caches, retaining persistent profile stores',async()=>{
 const f=await swap('cache');expect(f.code).toBe(13);
 for(const name of ['Cache','Code Cache','GPUCache'])expect(existsSync(join(f.data,'electron',name))).toBe(false);
 for(const name of ['Local Storage','IndexedDB','Cookies'])expect(readFileSync(join(f.data,'electron',name,'content'),'utf8')).toBe(name);
 expect(existsSync(join(f.data,'electron/Partitions/synthetic/Cache'))).toBe(false);
 for(const dir of ['core/Cache','electron/Partitions/synthetic/Local Storage'])expect(readFileSync(join(f.data,dir,'content'),'utf8')).toBe('persistent');
});
it.each(['restore','rm','move-old','move-new'] as const)('C2 failed restore %s preserves live data and never reopens it',async(mode)=>{
 const f=await swap(mode);expect(readFileSync(join(f.data,'schema'),'utf8')).toBe('candidate');
 expect(existsSync(f.opened)).toBe(false);expect(readFileSync(join(f.root,'result'),'utf8')).toMatch(/^failed:(19|20|21)\n$/);
 expect(readFileSync(join(f.root,'data-before/schema'),'utf8')).toBe('old-flushed');
 const message=await recoverUpdates(f.data,f.target);expect(message).toContain(join(f.root,'data-before'));
});
it('C3 rollback does not invent empty --env variables for truly unset values',async()=>{
 const f=await swap('env');const args=readFileSync(f.opened,'utf8').split('\n');
 for(const key of ['BOTLING_IMPORT_FROM','BOTLING_1X_DIR','CODEX_HOME','TMPDIR','CLAUDE_CONFIG_DIR'])expect(args.some(s=>s.startsWith(key+'=')),key).toBe(false);
 expect(args).toContain('BOTLING_DATA_DIR='+f.data);
});
it('GC joins an active foreign collector instead of returning before its deletion completes',async()=>{
 const f=fixture(),gc=join(f.base,'.botling-update-gc-c'),claims=join(f.data,'update-cleanup');
 rmSync(f.root,{recursive:true});mkdirSync(gc);mkdirSync(join(gc,'failed.app'));mkdirSync(claims);
 const release=join(f.base,'release'),started=join(f.base,'started'),lease=join(claims,'.botling-update-gc-c.json');
 const worker=join(f.base,'collector.sh');writeFileSync(worker,`#!/bin/sh\necho started > '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.02; done\n/bin/rm -rf '${gc}'; /bin/rm -f '${lease}'\n`);
 const child=spawn('/bin/sh',[worker],{stdio:'ignore'});cleanups.push(()=>{child.kill('SIGKILL');});const ended=once(child,'exit');
 writeFileSync(lease,JSON.stringify({root:'.botling-update-gc-c',target:f.target,dataDir:f.data,result:'failed:13',failure:'failed',collectorPid:child.pid}));
 await until(()=>existsSync(started));let done=false;const collecting=recoverUpdates(f.data,f.target).then(()=>{done=true;});
 try{await new Promise(r=>setTimeout(r,100));expect(done).toBe(false);}finally{writeFileSync(release,'release');await ended;await collecting;}
 expect(existsSync(gc)).toBe(false);
});

it('C3 empty and absent directory overrides default to the synthetic HOME',()=>{
 for(const env of [{},{CODEX_HOME:'',CLAUDE_CONFIG_DIR:'',TMPDIR:'',BOTLING_IMPORT_FROM:'',BOTLING_1X_DIR:''}] as Record<string,string>[]){
  directoryDefaults(env,'/synthetic-home',true);expect(env.CODEX_HOME).toBeUndefined();expect(env.TMPDIR).toBeUndefined();expect(env.BOTLING_IMPORT_FROM).toBe('/synthetic-home/.claudecodebot');expect(env.BOTLING_1X_DIR).toBe('/synthetic-home/.claudecodebot');
 }
});
it('C2 a missing result after a rollback decision blocks normal startup',()=>{
 const f=fixture();writeFileSync(join(f.root,'decision'),'rollback:c-token');writeFileSync(join(f.root,'helper.pid'),'99999999');
 expect(blockingRecovery(f.data)?.message).toContain(join(f.root,'data-before'));
});
it('C7 active helper and rollback decisions forbid candidate self-commit',async()=>{
 const f=fixture();writeFileSync(join(f.root,'boot.ok'),'c-token');writeFileSync(join(f.root,'new.pid'),String(process.pid));writeFileSync(join(f.root,'helper.pid'),String(process.pid));
 const args=['--botling-update-token=c-token'];expect(await commitUpdateReceipt(f.data,f.target,'2.0.1',args)).toBe('waiting');
 writeFileSync(join(f.root,'helper.pid'),'99999999');writeFileSync(join(f.root,'decision'),'rollback:c-token');
 expect(await commitUpdateReceipt(f.data,f.target,'2.0.1',args)).toBe('blocked');expect(existsSync(join(f.root,'result'))).toBe(false);
});
