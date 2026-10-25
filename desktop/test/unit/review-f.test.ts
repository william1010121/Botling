import {afterEach,expect,it} from 'vitest';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync,cpSync,lstatSync,symlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as state from '../../src/main/update-state';
import {Command} from '../../src/contract';
import {tempDir,until} from '../helpers';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const bases:string[]=[];afterEach(()=>{for(const b of bases.splice(0))rmSync(b,{recursive:true,force:true});});
function fixture(code=19){const base=tempDir('review-f'),data=join(base,'data'),target=join(base,'Botling 2.app'),root=join(base,'.botling-update-f'),token=randomUUID();bases.push(base);for(const p of [data,target,root])mkdirSync(p,{recursive:true});mkdirSync(join(data,'core/main'),{recursive:true});writeFileSync(join(data,'core/settings.json'),'{}');writeFileSync(join(data,'core/main/chat.json'),'[]');writeFileSync(join(root,'owner.json'),JSON.stringify({target,dataDir:data,token}));writeFileSync(join(root,'result'),'failed:'+code);return{base,data,target,root,token,issue:state.issueFor(data,target,root,code,token)};}
function snapshot(f:ReturnType<typeof fixture>){cpSync(f.data,join(f.root,'data-before'),{recursive:true});writeFileSync(join(f.root,'snapshot.complete'),'complete');}
it.each([15,16,22])('F2 failed%s before any data move accepts proven original live data without a complete snapshot',async code=>{const f=fixture(code),stat=lstatSync(f.data);writeFileSync(join(f.root,'original-data.identity'),`${stat.dev}:${stat.ino}`);await expect(state.validateRestoredData(f.issue)).resolves.toEqual(expect.any(String));});
it('F2 an invalid receipt root can acknowledge the exact data identity captured before startup',async()=>{const f=fixture(25),stat=lstatSync(f.data);const issue={...state.issueFor(f.data,f.target,dirname(f.target),25,f.token),originalDataIdentity:`${stat.dev}:${stat.ino}`};await expect(state.validateRestoredData(issue)).resolves.toEqual(expect.any(String));});
it('F2 no comparable copy must not permit an arbitrary recognizable replacement',async()=>{const f=fixture(22),stat=lstatSync(f.data);writeFileSync(join(f.root,'original-data.identity'),`${stat.dev}:${stat.ino}`);rmSync(f.data,{recursive:true});mkdirSync(join(f.data,'core'),{recursive:true});writeFileSync(join(f.data,'core/settings.json'),'{}');await expect(state.validateRestoredData(f.issue)).rejects.toThrow(/original|restore|match/i);});
it('F3 Finder metadata does not make an otherwise complete restore fail',async()=>{const f=fixture();snapshot(f);writeFileSync(join(f.data,'core/.DS_Store'),'Finder');writeFileSync(join(f.data,'core/._settings.json'),'Finder fork');writeFileSync(join(f.data,'Icon\r'),'Finder icon');await expect(state.validateRestoredData(f.issue)).resolves.toEqual(expect.any(String));});
it('F3 reports asynchronous core validation progress and ignores regenerable profile differences',async()=>{const f=fixture();snapshot(f);mkdirSync(join(f.data,'electron'),{recursive:true});writeFileSync(join(f.data,'electron/transient'),'new profile');const progress:string[]=[];await expect((state.validateRestoredData as any)(f.issue,(value:string)=>progress.push(value))).resolves.toEqual(expect.any(String));expect(progress.length).toBeGreaterThan(0);});
it('F5 deleting older copies never silently removes newer candidate data',async()=>{const f=fixture();snapshot(f);const after=f.data+'.update-after-'+f.token;cpSync(f.data,after,{recursive:true});writeFileSync(join(after,'core/main/chat.json'),'[{"id":"newer"}]');await state.deleteRecoveryCopies(f.issue,[]);expect(existsSync(after)).toBe(true);});
it('F6 does not rewrite an unchanged recovery failure record on repeated startup',async()=>{const f=fixture(14);await state.recordIssue(f.issue);const before=lstatSync(join(f.data,'update-recovery.json'));await state.recordIssue({...f.issue,at:f.issue.at+100});expect(lstatSync(join(f.data,'update-recovery.json')).ino).toBe(before.ino);});
it('F6 detects a local data symlink into an absent volume without following it into mkdir',()=>{const f=fixture(),link=join(f.base,'linked-data');symlinkSync('/Volumes/definitely-not-mounted-botling-test/data',link);expect(state.dataVolumeError(link)).toMatch(/volume.*unavailable/i);expect(existsSync('/Volumes/definitely-not-mounted-botling-test')).toBe(false);});
it('F1 Settings can enumerate and explicitly manage retained copies',()=>{expect(Command.safeParse({type:'updates.copies'}).success).toBe(true);expect(Command.safeParse({type:'updates.deleteCopy',id:'a'.repeat(64)}).success).toBe(true);});
it('F4 canceled/error recovery renders reuse the same window identity',async()=>{const mod=await import('../../src/main/recovery-window').catch(()=>null);expect(mod).not.toBeNull();let created=0;const host=new mod!.RecoveryWindowHost();const factory=()=>({id:++created,isDestroyed:()=>false});expect(host.get(factory)).toBe(host.get(factory));expect(created).toBe(1);});
it('F1 success keeps data discoverable at an old app location and only removes a proven obsolete previous app',async()=>{
 const {rememberRetained,retainedUpdateCopies,canRemovePrevious}=await import('../../src/main/update-copies');const {recoverUpdates}=await import('../../src/main/update-install');
 const f=fixture(0);snapshot(f);mkdirSync(join(f.root,'previous.app'));writeFileSync(join(f.root,'result'),'booted');writeFileSync(join(f.root,'activated.ok'),f.token);
 expect(await canRemovePrevious(f.issue,[f.target])).toBe(false);
 writeFileSync(join(f.data,'update-last-boot.json'),JSON.stringify({token:f.token,activated:true}));
 expect(await canRemovePrevious(f.issue,[join(f.root,'previous.app'),f.target])).toBe(false);
 expect(await canRemovePrevious(f.issue,[f.target])).toBe(true);
 await rememberRetained(f.data,f.root,f.target);const moved=join(f.base,'moved/Botling 2.app');mkdirSync(moved,{recursive:true});
 const copies=await retainedUpdateCopies(f.data,moved,[]);expect(copies.map(c=>c.role)).toContain('snapshot');expect(copies.find(c=>c.role==='snapshot')!.bytes).toBeGreaterThan(0);
 // Actual collection with no running good target conservatively keeps previous.app and data.
 await recoverUpdates(f.data,f.target);expect(existsSync(join(f.root,'data-before'))).toBe(true);expect(existsSync(join(f.root,'previous.app'))).toBe(true);
});
it('F1 Settings deletes only the selected owner-derived copy, keeps newer data, and refuses unknown ids',async()=>{
 const {retainedUpdateCopies,deleteRetainedUpdateCopy}=await import('../../src/main/update-copies');const f=fixture(0);snapshot(f);writeFileSync(join(f.root,'result'),'booted');
 const after=f.data+'.update-after-'+f.token;cpSync(f.data,after,{recursive:true});writeFileSync(join(after,'core/main/chat.json'),'[{"id":"newer"}]');
 const copies=await retainedUpdateCopies(f.data,f.target,[]),before=copies.find(c=>c.role==='snapshot')!;
 expect(copies.find(c=>c.role==='newer')!.path).toBe(after);await expect(deleteRetainedUpdateCopy(f.data,f.target,'0'.repeat(64),[])).rejects.toThrow(/changed/);
 await deleteRetainedUpdateCopy(f.data,f.target,before.id,[]);expect(existsSync(before.path)).toBe(false);expect(existsSync(after)).toBe(true);
});
it('F2 a legacy pre-candidate failure needs complete path provenance; directory existence alone is insufficient',async()=>{
 const f=fixture(22);await expect(state.validateRestoredData(f.issue)).rejects.toThrow(/original|match/);
 writeFileSync(join(f.root,'recovery.json'),JSON.stringify({dataDir:f.data,before:join(f.root,'data-before')}));await expect(state.validateRestoredData(f.issue)).resolves.toEqual(expect.any(String));
 writeFileSync(join(f.root,'new.pid'),'99999999');await expect(state.validateRestoredData(f.issue)).rejects.toThrow(/original|match/);
});
it('F2 captures persistent provenance before creating data and preserves it through invalid-receipt recovery',async()=>{
 const f=fixture(25);rmSync(join(f.data,'core'),{recursive:true});expect(state.persistentDataIdentity(f.data)).toBeUndefined();mkdirSync(join(f.data,'core'));writeFileSync(join(f.data,'core/settings.json'),'{}');
 const identity=state.persistentDataIdentity(f.data);expect(identity).toBeTruthy();rmSync(join(f.root,'result'));rmSync(f.root,{recursive:true});
 expect(await state.commitUpdateReceipt(f.data,f.target,'2.0.1',['--botling-update-token='+f.token],identity)).toBe('blocked');
 const issue=state.blockingRecovery(f.data,f.target)!;expect(issue.originalDataIdentity).toBe(identity);await state.completeRecovery(f.data,f.target,issue.id);expect(state.blockingRecovery(f.data,f.target)).toBeNull();
});
it('F3 core bytes remain meaningful: same-length changed messages fail despite ignored Finder files',async()=>{
 const f=fixture();writeFileSync(join(f.data,'core/main/chat.json'),'[{"a":1}]');snapshot(f);writeFileSync(join(f.data,'core/main/chat.json'),'[{"a":2}]');await expect(state.validateRestoredData(f.issue)).rejects.toThrow(/match/);
});
it('F3 busy recovery rendering exposes progress and suppresses actionable links',()=>{const f=fixture();const html=state.recoveryHTML(f.issue,undefined,[],'Comparing core data');expect(html).toContain('role="status"');expect(html).toContain('Comparing core data');expect(html).not.toContain('href="botling-recovery:');});
it('F4 a closed recovery window is recreated once, while canceled/error redraws preserve the live identity',async()=>{const {RecoveryWindowHost}=await import('../../src/main/recovery-window');let dead=false,created=0;const host=new RecoveryWindowHost<{id:number;isDestroyed():boolean}>();const create=()=>({id:++created,isDestroyed:()=>dead});host.get(create);dead=true;host.get(create);expect(created).toBe(2);dead=false;expect(host.get(create).id).toBe(2);});
it('F6 a new failure remains visible after an earlier failure was dismissed',async()=>{const f=fixture(14);await state.recordIssue(f.issue);await state.dismissRecovery(f.data,f.issue.id);expect(state.visibleRecovery(f.data).recoveryError).toBeNull();const newer=state.issueFor(f.data,f.target,f.root,12,'new-token',f.issue.at+1);await state.recordIssue(newer);expect(state.visibleRecovery(f.data).recoveryId).toBe(newer.id);});

it('F1 native collection removes only a nonrunning previous app after real commit and activation evidence',async()=>{
 const {recoverUpdates}=await import('../../src/main/update-install');const f=fixture(0);snapshot(f);mkdirSync(join(f.root,'previous.app'));writeFileSync(join(f.root,'result'),'booted');writeFileSync(join(f.root,'activated.ok'),f.token);writeFileSync(join(f.data,'update-last-boot.json'),JSON.stringify({token:f.token,activated:true}));
 const exe=join(f.target,'Contents/MacOS/SyntheticSleep');mkdirSync(dirname(exe),{recursive:true});cpSync('/bin/sleep',exe);const child=spawn(exe,['30'],{stdio:'ignore'}),ended=once(child,'exit');
 try{const {runningAppBundles}=await import('../../src/main/update-install');await until(async()=>(await runningAppBundles()).includes(f.target));await recoverUpdates(f.data,f.target);expect(existsSync(join(f.root,'previous.app'))).toBe(false);expect(existsSync(join(f.root,'data-before/core/settings.json'))).toBe(true);expect(existsSync(join(f.data,'update-retained'))).toBe(true);}
 finally{child.kill('SIGTERM');await ended;}
});
it('F1 active transactions and a missing live core cannot authorize copy deletion',async()=>{const {retainedUpdateCopies,deleteRetainedUpdateCopy}=await import('../../src/main/update-copies');const f=fixture(0);snapshot(f);writeFileSync(join(f.root,'helper.pid'),String(process.pid));let copies=await retainedUpdateCopies(f.data,f.target,[]);expect(copies.every(copy=>!copy.deletable)).toBe(true);await expect(deleteRetainedUpdateCopy(f.data,f.target,copies[0]!.id,[])).rejects.toThrow(/running/);rmSync(join(f.root,'helper.pid'));copies=await retainedUpdateCopies(f.data,f.target,[]);rmSync(join(f.data,'core'),{recursive:true});await expect(deleteRetainedUpdateCopy(f.data,f.target,copies[0]!.id,[])).rejects.toThrow(/unavailable/);expect(existsSync(join(f.root,'data-before'))).toBe(true);});
