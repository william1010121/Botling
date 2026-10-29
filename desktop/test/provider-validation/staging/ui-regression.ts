import {strict as assert} from 'node:assert';
import type {BrowserWindow} from 'electron';
import type {SafeController} from './safe-controller';
/** Native Chromium event delivery reproduces capture/target microtask boundaries.
 * Only called in --ui-regression with SafeController, which cannot create cards. */
export async function checkUI(window:BrowserWindow,controller:SafeController){
 const page=window.webContents,delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
 async function read(){return page.executeJavaScript(`({busy:document.body.getAttribute('aria-busy'),disabled:document.querySelector('#write').disabled,cancelDisabled:document.querySelector('#cancel').disabled,status:document.querySelector('#status').textContent,error:document.querySelector('#error').textContent,focus:document.activeElement.id})`);}
 async function click(selector:string){
  const point=await page.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  page.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  page.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
 }
 for(let i=0;i<20&&(await read()).disabled;i++)await delay(50);
 assert.equal((await read()).disabled,false,'Renderer readiness must enable Start');
 await page.executeJavaScript("document.querySelector('#write').click()");await delay(30);
 assert.equal(controller.calls.start,0,'Untrusted programmatic clicks must not dispatch');
 controller.rejectNextStart=true;
 await click('#write');await delay(40);
 assert.equal(controller.calls.start,1,'Native Start click must reach preload IPC and main exactly once');
 let view=await read();assert.equal(view.busy,'true');assert.equal(view.disabled,true);assert.match(view.status,/檢查/);
 await delay(320);view=await read();assert.match(view.error,/intentional prerequisite failure/);assert.equal(view.disabled,false);
 // Keyboard activation uses the same actual event path, not HTMLElement.click().
 await page.executeJavaScript("document.querySelector('#write').focus()");
 assert.equal((await read()).focus,'write');
 page.sendInputEvent({type:'keyDown',keyCode:'Return'});page.sendInputEvent({type:'char',keyCode:'\r'});page.sendInputEvent({type:'keyUp',keyCode:'Return'});
 await delay(350);assert.equal(controller.calls.start,2);view=await read();assert.equal(view.disabled,true);assert.equal(view.error,'');assert.match(view.status,/介面回應正常/);
 await click('#cancel');await delay(80);
 assert.equal(controller.calls.cancel,1,'Cancel click must reach main');view=await read();assert.equal(view.cancelDisabled,true);assert.match(view.status,/清理完成/);
 return {passed:true,nativeStart:1,keyboardStart:1,cancel:1,syntheticClickRejected:true,immediateBusyFeedback:true,errorAndRetry:true,focus:true,disabledState:true,providerProcesses:0,approvalChoices:0};
}
