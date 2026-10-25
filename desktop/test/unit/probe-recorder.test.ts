import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
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

// Execute the spec's actual finalizer with offline collaborators, without importing Playwright
// or launch(). This catches a rejected shutdown skipping evidence and masking the first error.
async function runFinalizer(options:{original?:Error;shutdown?:Error;inventory?:Error;checkpoint?:Error;cleanup?:Error}={}) {
 const source=readFileSync(join(import.meta.dirname,'../e2e/hidden-frontmost.spec.ts'),'utf8'),ast=ts.createSourceFile('probe.ts',source,ts.ScriptTarget.Latest,true);
 const blocks:ts.Block[]=[];
 const visit=(node:ts.Node)=>{if(ts.isTryStatement(node)&&node.finallyBlock?.getText(ast).includes('await closeOwn()'))blocks.push(node.finallyBlock);ts.forEachChild(node,visit);};visit(ast);expect(blocks).toHaveLength(1);
 const m=await import('../probe-recorder'),dir=tempDir('probe-finalizer');dirs.push(dir);const file=join(dir,'proof.json'),calls:string[]=[];
 const context={Error,failure:options.original,finalizationErrors:[] as unknown[],stop:false,completed:true,root:'synthetic-stage',data:'synthetic-data',original:options.original,
  closeOwn:async()=>{calls.push('shutdown');if(options.shutdown)throw options.shutdown;},monitor:Promise.resolve(),launchTask:Promise.resolve(),
  matchingPids:async()=>{calls.push('inventory');if(options.inventory)throw options.inventory;return[];},
  checkpoint:(status:string,remainingPids:number[]|null)=>{calls.push('checkpoint');if(options.checkpoint)throw options.checkpoint;m.writeProbeCheckpoint(file,{passed:context.completed&&!context.failure,status,remainingPids,samples:[{pid:42,bundleId:'org.synthetic'}],failure:context.failure?{message:context.failure.message}:null,finalizationErrors:context.finalizationErrors});},
  rmSync:(path:string)=>{calls.push('cleanup:'+path);if(path==='synthetic-stage'&&options.cleanup)throw options.cleanup;},
 };
 const body=blocks[0].getText(ast),compiled=ts.transpileModule(`async function run(){try{if(original)throw original;}finally${body}};run`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 let thrown:unknown;try{await runInNewContext(compiled,context)();}catch(error){thrown=error;}
 let saved:any;try{saved=JSON.parse(readFileSync(file,'utf8'));}catch{}
 return{calls,thrown,saved,context};
}
it('actual finalizer persists successful evidence and attempts both fixture cleanups',async()=>{
 const r=await runFinalizer();expect(r.thrown).toBeUndefined();expect(r.calls).toEqual(expect.arrayContaining(['shutdown','inventory','checkpoint','cleanup:synthetic-stage','cleanup:synthetic-data']));expect(r.saved).toMatchObject({passed:true,status:'complete',remainingPids:[],samples:[{pid:42}]});expect(r.context.stop).toBe(true);
});
it('actual finalizer records and cleans after shutdown rejection without replacing the original error',async()=>{
 const original=new Error('original metadata failure'),shutdown=new Error('shutdown rejected'),r=await runFinalizer({original,shutdown});
 expect(r.calls).toEqual(expect.arrayContaining(['checkpoint','cleanup:synthetic-stage','cleanup:synthetic-data']));expect(r.thrown).toBe(original);expect(r.saved).toMatchObject({passed:false,status:'failed',failure:{message:original.message},samples:[{pid:42}],finalizationErrors:[{stage:'shutdown',message:shutdown.message}]});expect(r.context.stop).toBe(true);
});
it('shutdown rejection alone makes the final proof fail while preserving observations and cleanup',async()=>{
 const shutdown=new Error('shutdown rejected'),r=await runFinalizer({shutdown});expect(r.thrown).toBe(shutdown);expect(r.calls).toContain('cleanup:synthetic-data');expect(r.saved).toMatchObject({passed:false,status:'failed',failure:{message:shutdown.message},samples:[{pid:42}]});
});
it('checkpoint failure cannot skip either cleanup or replace the original failure',async()=>{
 const original=new Error('original failure'),r=await runFinalizer({original,checkpoint:new Error('disk write failed')});expect(r.thrown).toBe(original);expect(r.calls).toEqual(expect.arrayContaining(['checkpoint','cleanup:synthetic-stage','cleanup:synthetic-data']));
});
it('one fixture cleanup failure cannot skip the other cleanup or final evidence',async()=>{
 const original=new Error('original failure'),cleanup=new Error('stage cleanup failed'),r=await runFinalizer({original,cleanup});expect(r.thrown).toBe(original);expect(r.calls).toEqual(expect.arrayContaining(['checkpoint','cleanup:synthetic-stage','cleanup:synthetic-data']));expect(r.saved).toMatchObject({passed:false,failure:{message:original.message},finalizationErrors:[{stage:'stage-cleanup',message:cleanup.message}]});
});
it('inventory failure still records evidence without claiming an empty process list',async()=>{
 const inventory=new Error('process metadata unavailable'),r=await runFinalizer({inventory});expect(r.thrown).toBe(inventory);expect(r.calls).toContain('cleanup:synthetic-data');expect(r.saved).toMatchObject({passed:false,status:'failed',remainingPids:null,failure:{message:inventory.message}});
});
