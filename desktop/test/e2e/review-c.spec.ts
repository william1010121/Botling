import {expect,test} from '@playwright/test';
import {existsSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {launch,post,chatFrame,MAIN} from './launch';
import {tempDir,swiftLine} from '../helpers';
import {previewURL} from '../../src/core/preview-url';

test('C4 large Chinese HTML without meta uses a bounded UTF8 prefix despite a cut-off code point',async()=>{
 const dir=join(tempDir('c4'),'artifacts');mkdirSync(dir);const file=join(dir,'large.html');writeFileSync(file,'<html><body><p id="probe">中文正確</p>'+'中'.repeat(40000)+'</body></html>');
 const run=await launch();try{
  const result=await run.app.evaluate(async({net,BrowserWindow},url)=>{
   const response=await net.fetch(url);const type=response.headers.get('content-type');await response.body?.cancel();
   const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
   try{await w.loadURL(url);return{type,text:await w.webContents.executeJavaScript('document.querySelector("#probe").textContent')};}finally{w.destroy();}
  },previewURL(file));
  expect(result).toEqual({type:'text/html; charset=utf-8',text:'中文正確'});
 }finally{await run.app.close();}
});

test('C5 dismiss persists across relaunch for one failure; a new identical failure still appears',async()=>{
 const data=tempDir('c5');let run=await launch({dataDir:data});const executable=await run.app.evaluate(()=>process.execPath);const target=dirname(dirname(dirname(executable)));await run.app.close();
 const roots:string[]=[];
 const failed=()=>{const token=randomUUID(),root=join(dirname(target),'.botling-update-c5-'+token);roots.push(root);mkdirSync(root);writeFileSync(join(root,'owner.json'),JSON.stringify({pid:99999999,target,dataDir:data,token}));writeFileSync(join(root,'result'),'failed:14\n');writeFileSync(join(data,'update-pending.json'),JSON.stringify({root,target,token,version:'2.0.1',executable:'TestApp'}));};
 try{
  failed();run=await launch({dataDir:data});const banner=run.page.getByRole('alert',{name:'Update recovery'});await expect(banner).toContainText('failed:14');await run.page.screenshot({path:join(process.cwd(),'.cache/evidence/review-c/recovery-banner.png')});await banner.getByRole('button',{name:'Dismiss'}).click();await expect(banner).toHaveCount(0);await run.app.close();
  run=await launch({dataDir:data});expect((await post(run.page,{v:10,id:'dismissed-check',cmd:{type:'updates.check',manual:false}})).result.recoveryError).toBeNull();await expect(run.page.getByRole('alert',{name:'Update recovery'})).toHaveCount(0);await run.app.close();
  failed();run=await launch({dataDir:data});await expect(run.page.getByRole('alert',{name:'Update recovery'})).toContainText('failed:14');
 }finally{await run.app.close().catch(()=>{});for(const root of roots)rmSync(root,{recursive:true,force:true});}
});

test('C6 component opens cannot borrow user links or ordinary click authority',async()=>{
 const file=join(tempDir('c6'),'synthetic.txt');writeFileSync(file,'synthetic');const local=pathToFileURL(file).href;
 const run=await launch({chat:[swiftLine({id:randomUUID().toUpperCase(),role:'user',text:`[ordinary](https://example.org/user-only) [user file](${local})`}),swiftLine({id:randomUUID().toUpperCase(),role:'bot',text:'[bot owned](https://example.org/bot-owned)',state:'done'})]});
 try{
  const frame=await chatFrame(run.page);const opened=()=>run.app.evaluate(()=>(globalThis as any).__botlingOpenedResults);
  await frame.evaluate(()=>{(window as any).webkit.messageHandlers.ccb.postMessage({type:'openExternal',url:'https://example.org/user-only'});});
  await run.page.waitForTimeout(120);expect(await opened()).toEqual([]);
  // User text is currently literal. Add the same link-chip DOM used by the reused Markdown/viewer
  // to exercise a real trusted click without changing Web/src or granting user-line authorization.
  await frame.evaluate(local=>{for(const [label,url] of [['ordinary','https://example.org/user-only'],['user file',local],['mail','mailto:synthetic@example.org']]){const a=document.createElement('a');a.href='#';a.dataset.url=url;a.textContent=label;document.querySelector('.user-body')!.append(a);}},local);
  await run.chat.getByRole('link',{name:'ordinary',exact:true}).click();await expect.poll(opened).toEqual(['https://example.org/user-only']);
  await run.chat.getByRole('link',{name:'user file',exact:true}).click();await run.page.waitForTimeout(100);expect(await opened()).not.toContain(local);
  await run.chat.getByRole('link',{name:'mail',exact:true}).click();await expect.poll(opened).toContain('mailto:synthetic@example.org');
  await frame.evaluate(()=>{(window as any).webkit.messageHandlers.ccb.postMessage({type:'openURL',url:'https://example.org/not-in-bot-lines'});});await run.page.waitForTimeout(100);expect(await opened()).not.toContain('https://example.org/not-in-bot-lines');
  await frame.evaluate(()=>{(window as any).webkit.messageHandlers.ccb.postMessage({type:'openURL',url:'https://example.org/bot-owned'});});await expect.poll(opened).toContain('https://example.org/bot-owned');
  expect((await post(run.page,{v:10,id:'strict-result',cmd:{type:'result.open',botId:MAIN,url:local}})).ok).toBe(false);
 }finally{await run.app.close();}
});

test('C2 fatal restore startup shows exact recovery paths without starting core or opening its persistent profile',async()=>{
 const primer=await launch();const executable=await primer.app.evaluate(()=>process.execPath);await primer.app.close();
 const target=dirname(dirname(dirname(executable))),data=tempDir('c2-blocked'),token=randomUUID(),root=join(dirname(target),'.botling-update-c2-'+token);
 mkdirSync(join(root,'data-before'),{recursive:true});writeFileSync(join(root,'data-before/schema'),'complete old snapshot');
 mkdirSync(join(data,'core'));writeFileSync(join(data,'core/schema'),'candidate data');mkdirSync(join(data,'electron'));writeFileSync(join(data,'electron/sentinel'),'persistent profile');
 writeFileSync(join(root,'owner.json'),JSON.stringify({target,dataDir:data,token,pid:99999999}));writeFileSync(join(root,'result'),'failed:19\n');writeFileSync(join(data,'update-pending.json'),JSON.stringify({target,root,token,version:'2.0.1',executable:'TestApp'}));
 let run:Awaited<ReturnType<typeof launch>>|undefined;
 try{
  run=await launch({dataDir:data,waitForState:false});await expect(run.page.getByRole('alert',{name:'Update recovery'})).toContainText(join(root,'data-before'));
  expect(await run.app.evaluate(()=>(globalThis as any).__botlingCorePid())).toBeUndefined();
  expect(await run.app.evaluate(({app})=>app.getPath('userData'))).not.toBe(join(data,'electron'));
  expect(readFileSync(join(data,'core/schema'),'utf8')).toBe('candidate data');expect(readFileSync(join(data,'electron/sentinel'),'utf8')).toBe('persistent profile');expect(existsSync(join(root,'data-before/schema'))).toBe(true);
  await run.page.screenshot({path:join(process.cwd(),'.cache/evidence/review-c/blocked-recovery.png')});
 }finally{await run?.app.close().catch(()=>{});rmSync(root,{recursive:true,force:true});}
});
