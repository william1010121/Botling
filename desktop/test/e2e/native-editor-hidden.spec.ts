// Authorized hidden-only integration check. CDP input stays inside the renderer; never activate,
// show, click/focus a native window or send OS keyboard/IME events.
import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, MAIN } from './launch';
import { desktop, until } from '../helpers';
import { frontmost } from '../frontmost';
import { FrontmostProof } from '../frontmost-proof';

test.skip(process.env.BOTLING_TEST_NATIVE_EDITOR_HIDDEN !== '1', 'Explicit hidden nonactivating input-host test only');
test('native editor opening, overlays, chat switching and Whiteboard visibility contract stay hidden and preserve the first character', async()=>{
 test.setTimeout(45000);
 expect(process.env.BOTLING_TEST_ALLOW_FOCUS).not.toBe('1');
 const proof=new FrontmostProof(1500),folder=join(desktop,'.cache/evidence/native-editor-hidden');mkdirSync(folder,{recursive:true});
 let app:ElectronApplication|undefined,phase='before',stop=false,closing=false,failure:unknown,testFailure:unknown;
 const baseline=await frontmost();let at=Date.now();proof.sample(baseline,phase,at,at);
 const monitor=(async()=>{while(!stop){
  try{
   at=Date.now();proof.sample(await frontmost(),phase,at,Date.now());
   if(app&&!closing){const state=await app.evaluate(({BrowserWindow})=>({states:BrowserWindow.getAllWindows().map(w=>({id:w.id,visible:w.isVisible(),focused:w.isFocused()})),events:(globalThis as any).__hiddenInputEvents??[]}));proof.window(Date.now(),state.states,state.events);}
  }catch(error){if(!closing){failure=error;await app?.close().catch(()=>{});return;}}
  await new Promise(resolve=>setTimeout(resolve,150));
 }})();
 const checks:string[]=[];const steps:string[]=[];
 const step=(name:string)=>{steps.push(name);writeFileSync(join(folder,'steps.json'),JSON.stringify({at:Date.now(),steps},null,2));};
 try{
  await new Promise(resolve=>setTimeout(resolve,180));if(failure)throw failure;phase='during';
  const run=await launch({waitForState:false,env:{BOTLING_HIDDEN:'1',BOTLING_1X_DIR:'',BOTLING_IMPORT_FROM:''},onLaunched:async own=>{
   app=own;if(failure){await own.close();throw failure;}
   await own.evaluate(({app,BrowserWindow})=>{
    const events:any[]=[];(globalThis as any).__hiddenInputEvents=events;
    const watch=(w:any)=>{for(const event of ['show','focus'])w.on(event,()=>events.push({event,id:w.id}));};
    BrowserWindow.getAllWindows().forEach(watch);app.on('browser-window-created',(_event,w)=>watch(w));
   });
  }});app=run.app;
  const shell=await until(()=>app!.context().pages().find(page=>page.url()==='app://botling/index.html'),{what:'authenticated shell page'});
  step('shell and native roots identified');
  const editor=await until(()=>app!.context().pages().find(page=>page.url().includes('nativeHost=1')),{what:'native root page'});
  await editor.locator('html[data-chat]').waitFor({state:'attached'});
  const initialID=await app.evaluate(({webContents})=>webContents.getAllWebContents().find(c=>c.getURL().includes('nativeHost=1'))!.id);
  expect(await editor.evaluate(()=>document.activeElement?.classList.contains('cm-content'))).toBe(true);
  const cdp=await editor.context().newCDPSession(editor);
  await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'n',code:'KeyN',windowsVirtualKeyCode:78,text:'n'});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'n',code:'KeyN',windowsVirtualKeyCode:78});
  await expect(editor.locator('.cm-content')).toHaveText('n');checks.push('opening first CDP character retained without clicking the composer');
  const nativeVisible=()=>app!.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.some(v=>(v as any).webContents?.getURL().includes('nativeHost=1')&&v.getVisible()));
  await expect.poll(nativeVisible).toBe(true);
  // An actual shell menu uses the shared lifetime contract, not a role/class selector.
  await shell.getByRole('button',{name:'Quick settings',exact:true}).evaluate((element:HTMLElement)=>element.click());
  await expect(shell.locator('.sidebar-settings-popover')).toBeAttached();
  await expect.poll(nativeVisible).toBe(false);
  const image=shell.locator('[data-native-chat-snapshot]');
  await expect.poll(()=>image.evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0)).toBe(true);
  const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:false})).toPNG().toString('base64'));
  writeFileSync(join(folder,'chat-under-menu.png'),Buffer.from(png,'base64'));
  expect(await editor.locator('.cm-content').textContent()).toBe('n');checks.push('menu decodes preserved chat pixels before native suspension');
  await shell.getByRole('button',{name:'Close quick settings'}).evaluate((el:HTMLElement)=>el.click());
  await expect.poll(nativeVisible).toBe(true);
  await expect(image).toHaveCount(0);
  await shell.getByRole('button',{name:'Settings',exact:true}).evaluate((el:HTMLElement)=>el.click());
  await expect.poll(nativeVisible).toBe(false);
  await expect.poll(()=>image.evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0)).toBe(true);
  await shell.getByRole('button',{name:'Done',exact:true}).evaluate((el:HTMLElement)=>el.click());
  await expect.poll(nativeVisible).toBe(true);checks.push('dialog open/close preserves visible underlying chat');
  const another=await shell.locator('.bot-row').evaluateAll((rows,main)=>rows.map(el=>el.getAttribute('data-bot')).find(id=>id&&id!==main),MAIN);
  expect(another).toBeTruthy();
  await shell.locator(`.bot-row[data-bot="${another}"]`).evaluate((el:HTMLElement)=>el.click());
  await expect(editor.locator('html')).toHaveAttribute('data-chat',another!);
  await shell.locator(`.bot-row[data-bot="${MAIN}"]`).evaluate((el:HTMLElement)=>el.click());
  await expect(editor.locator('html')).toHaveAttribute('data-chat',MAIN);
  await expect(editor.locator('.cm-content')).toHaveText('n');checks.push('chat switch restores the first chat draft in the same native root');
  // The separate Whiteboard branch is intentionally not integrated. Exercise its exact CSS
  // boundary (.chat-column.whiteboard-on #chat-frame { display:none }), retaining this root.
  step('whiteboard: insert rule');await shell.evaluate(()=>document.styleSheets[0].insertRule('.chat-column.whiteboard-on #chat-frame { display:none; }'));
  step('whiteboard: hide placeholder');await shell.locator('.chat-column').evaluate(el=>el.classList.add('whiteboard-on'));
  await expect.poll(nativeVisible).toBe(false);
  step('whiteboard: restore placeholder');await shell.locator('.chat-column').evaluate(el=>el.classList.remove('whiteboard-on'));
  await expect.poll(nativeVisible).toBe(true);
  step('whiteboard: check editor state');await expect(editor.locator('.cm-content')).toHaveText('n');
  expect(await app.evaluate(({webContents})=>webContents.getAllWebContents().find(c=>c.getURL().includes('nativeHost=1'))!.id)).toBe(initialID);
  checks.push('Whiteboard CSS hide/show contract retains native identity and draft (feature branch not integrated)');
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,text:'a'});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65});
  await expect(editor.locator('.cm-content')).toHaveText('na');checks.push('typing resumes after overlays/visibility changes without refocusing the editor');
  // A real second-instance callback in hidden mode must remain nonactivating.
  step('second instance');await app.evaluate(({app})=>{app.emit('second-instance',{} as any,[],'');});
  if(failure)throw failure;
 }catch(error){testFailure=error;throw error;}finally{
  step('cleanup');closing=true;
  const child=app?.process();
  await Promise.race([app?.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,3000))]);
  if(child&&child.exitCode===null){child.kill('SIGTERM');await until(()=>child.exitCode!==null,{timeout:3000,what:'isolated test shutdown'}).catch(()=>child.kill('SIGKILL'));}
  app=undefined;phase='after';
  await new Promise(resolve=>setTimeout(resolve,350));stop=true;await monitor;
  let proofError:unknown;try{proof.complete();}catch(error){proofError=error;}
  writeFileSync(join(folder,'proof.json'),JSON.stringify({passed:!failure&&!testFailure&&!proofError,checks,steps,baseline:proof.baseline,samples:proof.samples,windows:proof.windows,failure:String(failure??testFailure??proofError??'')},null,2));
  if(failure)throw failure;if(proofError)throw proofError;
 }
});
