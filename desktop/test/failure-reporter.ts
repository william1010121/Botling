// Keep import/pool failures as well as test failures, even when the console summary has no cause.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Reporter,TestModule} from 'vitest/node';
export default class FailureReporter implements Reporter {
 onTestRunEnd(modules:readonly TestModule[],errors:readonly unknown[],reason:string){
  const folder=join(process.cwd(),'.cache/evidence/unit');mkdirSync(folder,{recursive:true});
  const failed=modules.filter(m=>m.errors().length||[...m.children.allTests('failed')].length);
  const record={at:new Date().toISOString(),pid:process.pid,node:process.version,reason,resources:process.resourceUsage(),memory:process.memoryUsage(),errors,
   modules:failed.map(m=>({file:m.moduleId,errors:m.errors(),tests:[...m.children.allTests('failed')].map(t=>({name:t.fullName,result:t.result()}))}))};
  const file=join(folder,`run-${Date.now()}-${process.pid}.json`);writeFileSync(file,JSON.stringify(record,null,2)+'\n');
  if(failed.length||errors.length)process.stderr.write(`Full unit failure evidence: ${file}\n`);
 }
}
