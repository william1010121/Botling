import {afterEach,expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync,cpSync} from 'node:fs';
import {join} from 'node:path';
import * as state from '../../src/main/update-state';
import {SWAP_SCRIPT,recoverUpdates} from '../../src/main/update-install';
import {tempDir,until} from '../helpers';
const cleanups:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();});
function fixture(){
 const base=tempDir('review-d'),target=join(base,'Botling 2.app'),root=join(base,'.botling-update-d'),data=join(base,'data'),token=randomUUID();
 for(const p of [target,root,data])mkdirSync(p,{recursive:true});
 const staged=join(root,'Botling 2.app');mkdirSync(join(staged,'Contents/MacOS'),{recursive:true});
 writeFileSync(join(staged,'Contents/MacOS/TestApp'),'#!/bin/sh\nexit 1\n',{mode:0o755});
 writeFileSync(join(data,'schema'),'old-flushed');mkdirSync(join(data,'core'),{recursive:true});writeFileSync(join(data,'core/settings.json'),'{}');writeFileSync(join(root,'owner.json'),JSON.stringify({pid:99999999,target,dataDir:data,token}));
 writeFileSync(join(data,'update-pending.json'),JSON.stringify({root,target,token,version:'2.0.1',executable:'TestApp'}));
 cleanups.push(()=>rmSync(base,{recursive:true,force:true}));return{base,target,root,data,token,staged};
}
async function shell(f:ReturnType<typeof fixture>,script=SWAP_SCRIPT){
 const file=join(f.root,'swap.sh'),open=join(f.base,'open');writeFileSync(open,'#!/bin/sh\nexit 0\n',{mode:0o755});writeFileSync(file,script.replaceAll('/usr/bin/open',open));
 const child=spawn('/bin/sh',[file,'99999999',f.target,f.staged,join(f.root,'previous.app'),join(f.root,'boot.ok'),f.token,'TestApp','0','0.02',f.data,'10','50'],{stdio:'ignore'});
 const exit=once(child,'exit');cleanups.push(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});return{child,exit};
}
it('D3 snapshots and restores exclude update control records, retaining persistent user data',async()=>{
 const f=fixture();writeFileSync(join(f.data,'update-recovery.json'),JSON.stringify({old:true}));
 const run=await shell(f);await run.exit;
 expect(readFileSync(join(f.data,'schema'),'utf8')).toBe('old-flushed');
 expect(existsSync(join(f.root,'data-before/update-pending.json'))).toBe(false);
 expect(existsSync(join(f.data,'update-pending.json'))).toBe(false);expect(existsSync(join(f.data,'update-recovery.json'))).toBe(false);
});
it('D3 explicit completion acknowledges only the selected failed transaction and permits normal startup',async()=>{
 const f=fixture();cpSync(f.data,join(f.root,'data-before'),{recursive:true});writeFileSync(join(f.root,'snapshot.complete'),'complete');writeFileSync(join(f.root,'result'),'failed:19');
 await state.recordIssue(state.issueFor(f.data,f.target,f.root,19,f.token));const issue=state.blockingRecovery(f.data)!;
 expect(typeof (state as any).completeRecovery).toBe('function');
 await expect((state as any).completeRecovery(f.data,f.target,'other')).rejects.toThrow();
 await (state as any).completeRecovery(f.data,f.target,issue.id);
 expect(state.blockingRecovery(f.data,f.target)).toBeNull();expect(existsSync(join(f.data,'update-pending.json'))).toBe(false);
 writeFileSync(join(f.root,'result'),'failed:20');expect(state.blockingRecovery(f.data,f.target)).not.toBeNull();
});
it('D4 TERM during the live-data rename gap cannot interrupt rollback',async()=>{
 const f=fixture(),gap=join(f.base,'gap'),release=join(f.base,'release'),wrapper=join(f.base,'mv');
 writeFileSync(wrapper,`#!/bin/sh\n/bin/mv "$@" || exit $?\nif [ "$1" = '${f.data}' ]; then echo gap > '${gap}'; while [ ! -f '${release}' ]; do sleep 0.02; done; fi\n`,{mode:0o755});
 const run=await shell(f,SWAP_SCRIPT.replaceAll('/bin/mv',wrapper));
 try{await until(()=>existsSync(gap));run.child.kill('SIGTERM');await new Promise(r=>setTimeout(r,100));expect(run.child.signalCode).toBeNull();}
 finally{writeFileSync(release,'go');await run.exit;}
 expect(readFileSync(join(f.data,'schema'),'utf8')).toBe('old-flushed');expect(readFileSync(join(f.root,'result'),'utf8')).toBe('failed:13\n');
});
it('D4 failure21 is discovered without a data directory through owned sibling metadata',()=>{
 const f=fixture();rmSync(f.data,{recursive:true});mkdirSync(join(f.root,'data-before'));mkdirSync(f.data+'.update-after-'+f.token);writeFileSync(join(f.root,'result'),'failed:21');
 expect(state.blockingRecovery(f.data,f.target)?.code).toBe(21);expect(existsSync(f.data)).toBe(false);
});
it('D5 reports extant copies only, including the current data stranded at after',()=>{
 const f=fixture();mkdirSync(join(f.root,'data-before'));const after=f.data+'.update-after-'+f.token;mkdirSync(after);rmSync(f.data,{recursive:true});
 const issue=state.issueFor(f.data,f.target,f.root,21,f.token);
 expect(issue.message).toContain(after);expect(issue.message).not.toContain('Prepared restore:');expect(issue.message).not.toContain('Current data: '+f.data+'.');
});
it('D6 helper death before new.pid produces a durable actionable recovery issue',async()=>{
 const f=fixture();writeFileSync(join(f.root,'helper.pid'),'99999999');writeFileSync(join(f.root,'boot.ok'),f.token);
 expect(await state.commitUpdateReceipt(f.data,f.target,'2.0.1',['--botling-update-token='+f.token])).toBe('blocked');
 expect(state.blockingRecovery(f.data,f.target)?.blocked).toBe(true);expect(state.visibleRecovery(f.data).recoveryError).toContain('recovery');
});
it('D7 legacy16 without restore evidence retains a partial snapshot without blocking future updates',async()=>{
 const f=fixture();mkdirSync(join(f.root,'data-before'));writeFileSync(join(f.root,'data-before/partial'),'partial');writeFileSync(join(f.root,'result'),'failed:16');
 expect(state.blockingRecovery(f.data,f.target)).toBeNull();await recoverUpdates(f.data,f.target);
 expect(existsSync(join(f.root,'data-before/partial'))).toBe(true);expect(existsSync(join(f.data,'update-pending.json'))).toBe(false);expect(readFileSync(join(f.data,'schema'),'utf8')).toBe('old-flushed');
});
it('D7 legacy16 with actual restore evidence preserves recoverable copies',async()=>{
 const f=fixture();mkdirSync(join(f.root,'data-before'));mkdirSync(join(f.root,'failed.app'));writeFileSync(join(f.root,'result'),'failed:16');
 expect(state.blockingRecovery(f.data,f.target)?.blocked).toBe(true);await recoverUpdates(f.data,f.target);expect(existsSync(join(f.root,'data-before'))).toBe(true);
});

it('D3 acknowledged recovery preserves owned copies after completion under explicit-delete policy',async()=>{
 const f=fixture(),after=f.data+'.update-after-'+f.token,restore=f.data+'.update-restore-'+f.token;
 for(const p of [join(f.root,'data-before'),after,restore])cpSync(f.data,p,{recursive:true});writeFileSync(join(f.root,'snapshot.complete'),'complete');
 writeFileSync(join(f.root,'recovery.json'),JSON.stringify({dataDir:f.data,token:f.token,after,restore}));writeFileSync(join(f.root,'result'),'failed:19');
 await state.completeRecovery(f.data,f.target,state.blockingRecovery(f.data,f.target)!.id);await recoverUpdates(f.data,f.target);
 expect(existsSync(f.root)).toBe(true);expect(existsSync(after)).toBe(true);expect(existsSync(restore)).toBe(true);expect(readFileSync(join(f.data,'schema'),'utf8')).toBe('old-flushed');expect(state.blockingRecovery(f.data,f.target)).toBeNull();
});
it('D3 restores of legacy snapshots strip stale update control files before making data live',async()=>{
 const f=fixture(),legacy=SWAP_SCRIPT.replace('snapshot=1; fi',`snapshot=1; printf stale > "$root/data-before/update-pending.json"; printf stale > "$root/data-before/update-recovery.json"; fi`);
 const run=await shell(f,legacy);await run.exit;
 expect(readFileSync(join(f.data,'schema'),'utf8')).toBe('old-flushed');expect(existsSync(join(f.data,'update-pending.json'))).toBe(false);expect(existsSync(join(f.data,'update-recovery.json'))).toBe(false);
});
