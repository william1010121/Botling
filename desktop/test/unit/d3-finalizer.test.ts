import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

// Run the real D3 finalizer offline, including a prior runtime failure and a disposed app.
async function finalize(queryFailure?:Error,exitCode:number|null=0){
 const text=readFileSync(join(import.meta.dirname,'../e2e/d3-hidden.spec.ts'),'utf8'),ast=ts.createSourceFile('probe.ts',text,ts.ScriptTarget.Latest,true),blocks:ts.Block[]=[];
 const visit=(node:ts.Node)=>{if(ts.isTryStatement(node)&&node.finallyBlock?.getText(ast).includes('for(const run of runs)'))blocks.push(node.finallyBlock);ts.forEachChild(node,visit);};visit(ast);expect(blocks).toHaveLength(1);
 const original=new Error('original delivery failure'),calls:string[]=[],samples:any[]=[],errors:any[]=[];
 const frontmost=vi.fn(async()=>{calls.push('query');if(queryFailure)throw queryFailure;return '42\torg.synthetic';});
 const context={Error,Date,original,failure:original,stop:false,phase:'during',label:'recovery',metadataFailed:false,runs:[{receipt:()=>({pid:99,exitCode,signalCode:null})}],finalizationErrors:errors,
  closeRun:async()=>{calls.push('close');},monitor:Promise.resolve(),launchTask:Promise.resolve(),matchingPids:async()=>{calls.push('inventory');return exitCode===null?[99]:[];},
  frontmost,proof:{sample:(value:string,phase:string)=>samples.push({value,phase}),complete:()=>{}},pause:async()=>{calls.push('pause');},checkpoint:()=>{calls.push('checkpoint');},note:()=>{},
  existsSync:()=>false,writeFileSync:()=>{},readFileSync:()=>'',rmSync:()=>{calls.push('cleanup');},join,root:'synthetic-root',data:'synthetic-data',normalData:'synthetic-normal',evidence:'synthetic-evidence',completed:false,
 };
 const compiled=ts.transpileModule(`async function run(){try{throw original;}finally${blocks[0].getText(ast)}};run`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 let thrown:unknown;try{await runInNewContext(compiled,context)();}catch(error){thrown=error;}
 return{original,thrown,calls,frontmost,samples,errors};
}
it('failed D3 action still collects two after-exit samples and checkpoints after confirmed process shutdown',async()=>{
 const r=await finalize();expect(r.thrown).toBe(r.original);expect(r.frontmost).toHaveBeenCalledTimes(2);expect(r.samples.map(s=>s.phase)).toEqual(['after','after']);expect(r.calls.indexOf('query')).toBeGreaterThan(r.calls.indexOf('close'));expect(r.calls.indexOf('query')).toBeGreaterThan(r.calls.indexOf('inventory'));expect(r.calls.filter(c=>c==='checkpoint').length).toBeGreaterThanOrEqual(3);expect(r.calls).toContain('cleanup');
});
it('after-exit metadata failure stops without retry and preserves the original failure and cleanup',async()=>{
 const r=await finalize(new Error('metadata unavailable'));expect(r.frontmost).toHaveBeenCalledTimes(1);expect(r.thrown).toBe(r.original);expect(r.errors).toContainEqual({stage:'after-sampling',message:'metadata unavailable'});expect(r.calls).toContain('cleanup');
});
it('a still-running isolated process cannot be labeled after-exit or sampled as exited',async()=>{
 const r=await finalize(undefined,null);expect(r.frontmost).not.toHaveBeenCalled();expect(r.samples).toEqual([]);expect(r.errors).toContainEqual({stage:'inventory',message:'Isolated processes remain'});expect(r.thrown).toBe(r.original);
});
