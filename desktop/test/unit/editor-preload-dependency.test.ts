import {expect,it} from 'vitest';
import {build} from 'esbuild';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {bundlePrints,planInstall} from '../../src/main/hot-install';
import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const {buildPreloads}=await import(resolve('build-preloads.mjs'));
it('both preload import graphs exclude the full contract',async()=>{
 for(const entry of ['preload','editor-host']){
  const result=await build({absWorkingDir:resolve('.'),preserveSymlinks:true,entryPoints:[`src/preload/${entry}.ts`],bundle:true,platform:'node',format:'cjs',external:['electron'],write:false,metafile:true});
  expect(Object.keys(result.metafile!.inputs)).not.toContain('src/contract/index.ts');
  expect(Object.keys(result.metafile!.inputs)).not.toContain('src/contract/doctor.ts');
 }
});
it('production preload bundles ignore unrelated contract edits but change for real card schema and wire edits',async()=>{
 const temporary=mkdtempSync(join(tmpdir(),'editor-preload-dependency-'));
 try{
  const root=join(temporary,'desktop'),outdir=join(root,'out/preload');mkdirSync(root);
  cpSync(resolve('src'),join(root,'src'),{recursive:true});
  mkdirSync(join(temporary,'Web/src'),{recursive:true});
  cpSync(resolve('../Web/src/contract.json'),join(temporary,'Web/src/contract.json'));
  symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');
  const bundle=async()=>{await buildPreloads({root,outdir});return ['preload.cjs','editor-host.cjs'].map(name=>readFileSync(join(outdir,name),'utf8'));};
  const prints=async(label:string)=>{
   const app=join(temporary,label),contents=join(app,'Contents');
   mkdirSync(contents,{recursive:true});
   writeFileSync(join(contents,'Info.plist'),'<plist><dict><key>CFBundleIdentifier</key><string>test.editor</string></dict></plist>');
   cpSync(outdir,join(contents,'Resources/app/out/preload'),{recursive:true});
   // Preload-only comparisons still require known, matching package/core storage metadata.
   const appRoot=join(contents,'Resources/app'),storageContract={version:1,epoch:2};
   writeFileSync(join(appRoot,'package.json'),JSON.stringify({botlingStorageContract:storageContract}));
   mkdirSync(join(appRoot,'out/core'),{recursive:true});
   writeFileSync(join(appRoot,'out/core/storage-contract.json'),JSON.stringify(storageContract));
   return bundlePrints(app,fs);
  };
  const baseline=await bundle(),baselinePrints=await prints('baseline');
  const contract=join(root,'src/contract/index.ts'),original=readFileSync(contract,'utf8');
  writeFileSync(contract,original.replace('MESSAGE_TEXT_LIMIT = 100_000','MESSAGE_TEXT_LIMIT = 100_001'));
  expect(await bundle()).toEqual(baseline);
  expect(planInstall(baselinePrints,await prints('unrelated'))).toEqual({mode:'hot',parts:[]});
  writeFileSync(contract,original);
  const schema=join(root,'src/contract/editor-card.ts');expect(existsSync(schema)).toBe(true);
  const card=readFileSync(schema,'utf8');expect(card).toContain('max(4_000)');
  writeFileSync(schema,card.replace('max(4_000)','max(4_001)'));
  const changed=await bundle();for(let i=0;i<2;i++)expect(changed[i]).not.toBe(baseline[i]);
  expect(planInstall(baselinePrints,await prints('card-change'))).toEqual({mode:'restart',reasons:['kernel changed: preloads']});
  writeFileSync(schema,card);
  const wire=join(root,'src/editor-host-wire.ts'),source=readFileSync(wire,'utf8');
  writeFileSync(wire,source.replace('1024*1024:16*1024*1024','1024*1024:15*1024*1024'));
  const wireChanged=await bundle();for(let i=0;i<2;i++)expect(wireChanged[i]).not.toBe(baseline[i]);
  expect(planInstall(baselinePrints,await prints('wire-change'))).toEqual({mode:'restart',reasons:['kernel changed: preloads']});
  console.log(JSON.stringify({sha256:baseline.map(x=>createHash('sha256').update(x).digest('hex')),bundleBytes:baseline.map(x=>Buffer.byteLength(x)),unrelatedContractUnchanged:true,cardSchemaChangedBoth:true,wireChangedBoth:true}));
 }finally{rmSync(temporary,{recursive:true,force:true});}
},30_000);
