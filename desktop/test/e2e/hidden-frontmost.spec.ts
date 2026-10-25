import {expect,test} from '@playwright/test';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {launch} from './launch';
import {desktop,tempDir} from '../helpers';
import {electronExecutable} from '../electron-runtime';
import {frontmost} from '../frontmost';
test.skip(process.env.BOTLING_TEST_VERIFY_HIDDEN!=='1','Single explicit F0 verification; not a native focus test');
test('F0 hidden recovery stays invisible and preserves the frontmost app',async()=>{
 const samples:{phase:string;at:number;frontmost:string}[]=[];const sample=async(phase:string)=>{const value=await frontmost();samples.push({phase,at:Date.now(),frontmost:value});return value;};
 const before=await sample('before'); // Fail closed before starting Electron if read-only verification is unavailable.
 const data=tempDir('f0-hidden'),token=randomUUID(),target=dirname(dirname(dirname(electronExecutable()))),root=join(dirname(target),'.botling-update-f0-'+token);mkdirSync(root);writeFileSync(join(root,'owner.json'),JSON.stringify({target,dataDir:data,token}));writeFileSync(join(root,'result'),'failed:19');
 let run:Awaited<ReturnType<typeof launch>>|undefined;
 try{run=await launch({dataDir:data,waitForState:false});await expect(run.page.getByRole('heading',{name:'Update recovery required'})).toBeVisible();await sample('during');const windows=await run.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focused:w.isFocused()})));expect(windows.every(w=>!w.visible&&!w.focused)).toBe(true);expect(await run.page.evaluate(()=>document.hasFocus())).toBe(true);await sample('during-after-emulation');}
 finally{await run?.app.close();rmSync(root,{recursive:true,force:true});await sample('after');writeFileSync(join(desktop,'.cache/evidence/review-f/f0-frontmost.json'),JSON.stringify(samples,null,2));}
 expect(samples.every(row=>row.frontmost===before)).toBe(true);
});
