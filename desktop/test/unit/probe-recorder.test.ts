import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tempDir} from '../helpers';
const dirs:string[]=[];afterEach(()=>{for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
it('cached child status survives Playwright application disposal without another process() call',async()=>{
 const m=await import('../probe-recorder');let disposed=false;const child={pid:42,exitCode:null as number|null,signalCode:null};const app={process:vi.fn(()=>{if(disposed)throw new TypeError("Cannot read properties of undefined (reading '_object')");return child;})};
 const receipt=m.captureProcessReceipt(app);disposed=true;child.exitCode=0;expect(receipt()).toEqual({pid:42,exitCode:0,signalCode:null});expect(app.process).toHaveBeenCalledTimes(1);
});
it('checkpoint persists observations before shutdown without querying an application',async()=>{
 const m=await import('../probe-recorder'),dir=tempDir('probe-recorder');dirs.push(dir);const file=join(dir,'checkpoint.json');m.writeProbeCheckpoint(file,{passed:false,status:'running',samples:[{pid:42,bundleId:'org.synthetic'}]});expect(JSON.parse(readFileSync(file,'utf8'))).toMatchObject({status:'running',samples:[{pid:42}]});
});
it('a process-receipt error preserves the original failure and writes failed evidence',async()=>{
 const m=await import('../probe-recorder'),dir=tempDir('probe-recorder-error');dirs.push(dir);const file=join(dir,'checkpoint.json');m.writeProbeCheckpoint(file,{passed:true,failure:{message:'original metadata failure'}},()=>{throw new Error('disposed handle');});const saved=JSON.parse(readFileSync(file,'utf8'));expect(saved.passed).toBe(false);expect(saved.failure.message).toBe('original metadata failure');expect(saved.recorderError).toContain('disposed handle');
});
