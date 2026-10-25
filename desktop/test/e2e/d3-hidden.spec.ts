import {test,expect,type ElectronApplication,type Page,type Locator} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {cpSync,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {launch,chatFrame} from './launch';
import {desktop,tempDir} from '../helpers';
import {electronExecutable} from '../electron-runtime';
import {frontmost} from '../frontmost';
import {FrontmostProof} from '../frontmost-proof';
import {captureProcessReceipt,writeProbeCheckpoint,type ProcessReceipt} from '../probe-recorder';

// D3-only DOM/broker observers. No input, focus, E3 trace capability or production source edits.
function observeD3Document(){
 const w=window as any;if(w.__d3Installed){w.__d3InstallBroker?.();return;}w.__d3Installed=true;
 const generation=String(performance.timeOrigin),ids=new WeakMap<object,number>();let next=0,seq=0;
 const node=(value:object|null)=>{if(!value)return null;let id=ids.get(value);if(!id){id=++next;ids.set(value,id);}return id;};
 const url=(value:string)=>value.startsWith('data:')?'data:recovery':value.slice(0,512);
 const emit=(event:string,data:unknown={})=>console.debug('d3-observe:'+JSON.stringify({at:performance.timeOrigin+performance.now(),generation,seq:++seq,event,url:url(location.href),data}));
 const frames=(root:any)=>{const found=[...(root.querySelectorAll?.('iframe')??[])];if(root.nodeName==='IFRAME')found.unshift(root);return found;};
 const snapshot=(frame:HTMLIFrameElement)=>({node:node(frame),connected:frame.isConnected,src:url(frame.src),window:node(frame.contentWindow)});
 const inserted=(root:Node,event:string)=>{for(const frame of frames(root))emit(event,snapshot(frame));};
 new MutationObserver(records=>{for(const record of records){for(const n of record.removedNodes)inserted(n,'card.iframe.remove');for(const n of record.addedNodes)inserted(n,'card.iframe.insert');}}).observe(document,{childList:true,subtree:true});
 document.addEventListener('load',event=>{if((event.target as Element)?.nodeName==='IFRAME')emit('card.iframe.load',snapshot(event.target as HTMLIFrameElement));},true);
 for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>{const raw=event.target as Element|null,target=raw?.closest?.('button,a');emit('dom.'+type,{trusted:event.isTrusted,rawTag:raw?.nodeName,rawId:raw?.id,action:target?{id:target.id,text:target.textContent?.slice(0,140)}:null});},true);
 window.addEventListener('message',event=>{
  const value=event.data;if(!value||typeof value!=='object')return;
  if(value.ccb==='save'||value.ccbData||value.botling==='request'&&value.cmd?.type==='card.save'||value.botling==='response'){
   const candidates=[...document.querySelectorAll('iframe')].filter(frame=>frame.contentWindow===event.source).map(snapshot);
   emit('message.observe',{origin:event.origin,candidates,registeredTargets:[...(w.__botlingBroker?.targets??[])].map((t:any)=>({card:t.messageId+'/'+t.cardId,...snapshot(t.frame)})),payload:value});
  }
 },true);
 inserted(document,'card.iframe.observed');emit('document.observed',{readyState:document.readyState});
 w.__d3InstallBroker=()=>{const broker=w.__botlingBroker;
 if(broker&&!broker.__d3Observed){
  broker.__d3Observed=true;emit('broker.observed',{targets:[...broker.targets].map((t:any)=>({card:t.messageId+'/'+t.cardId,...snapshot(t.frame)}))});
  const push=broker.accepted.push;broker.accepted.push=function(...items:unknown[]){emit('broker.accepted',items);return push.apply(this,items);};
  const refuse=broker.refuse;broker.refuse=function(reason:string,target:any){emit('broker.refused',{reason,card:target?target.messageId+'/'+target.cardId:null});return refuse.call(this,reason,target);};
  const save=broker.actions.save;broker.actions.save=function(target:any,data:string){emit('broker.save.request',{card:target.messageId+'/'+target.cardId,data,...snapshot(target.frame)});const result=save.call(this,target,data);void result.then(()=>emit('broker.save.resolved'),(error:Error)=>emit('broker.save.rejected',{message:error.message}));return result;};
  const send=broker.sendData;broker.sendData=function(target:any,data:string|null){emit('broker.data.send',{card:target.messageId+'/'+target.cardId,data,...snapshot(target.frame)});return send.call(this,target,data);};
 }};w.__d3InstallBroker();
}
const exec=promisify(execFile),pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
test.skip(process.env.BOTLING_TEST_D3_HIDDEN!=='1','Explicit bounded hidden D3 investigation only');
test('D3 hidden recovery redraw reuses its window; fresh counter click is correlated and durable',async()=>{
 test.setTimeout(45000);expect(process.env.BOTLING_TEST_ALLOW_FOCUS).not.toBe('1');
 const evidence=join(desktop,'.cache/evidence/run15');mkdirSync(evidence,{recursive:true});
 const executable=electronExecutable(),target=dirname(dirname(dirname(executable))),data=tempDir('d3-hidden'),normalData=tempDir('d3-counter-hidden'),token=randomUUID(),root=join(dirname(target),'.botling-update-d3-hidden-'+token),argument='--botling-update-data='+data;
 mkdirSync(join(data,'core'),{recursive:true});writeFileSync(join(data,'core/schema'),'restored synthetic data');writeFileSync(join(data,'core/settings.json'),'{}');cpSync(data,join(root,'data-before'),{recursive:true});writeFileSync(join(root,'snapshot.complete'),'complete');
 writeFileSync(join(root,'owner.json'),JSON.stringify({target,dataDir:data,token,pid:99999999}));writeFileSync(join(root,'result'),'failed:19');writeFileSync(join(data,'update-pending.json'),JSON.stringify({target,root,token,version:'2.0.1',executable:'TestApp'}));
 const proof=new FrontmostProof(750),startedAt=Date.now(),trace:any[]=[],runs:{label:string;app:ElectronApplication;receipt:()=>ProcessReceipt;closing?:Promise<void>;runtime:any}[]=[],finalizationErrors:{stage:string;message:string}[]=[];
 let phase='before',label='before',stop=false,metadataFailed=false,failure:Error|undefined,completed=false,current:typeof runs[number]|undefined,launchTask:Promise<unknown>|undefined,monitor:Promise<void>|undefined,abort!:()=>void;
 const aborted=new Promise<void>(resolve=>{abort=resolve;});
 const note=(event:string,details:any={})=>{if(trace.length<3000)trace.push({at:Date.now(),event,label,...details});else fail(new Error('D3 diagnostic record bound exceeded'));};
 const matchingPids=async()=>{const {stdout}=await exec('/bin/ps',['-axww','-o','pid=,comm=,args='],{maxBuffer:4*1024*1024});return stdout.split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);return match?.[2]===executable&&match[3].split(/\s+/).some(value=>value===argument||value==='--botling-update-data='+normalData)?[Number(match[1])]:[];});};
 const closeRun=(run:typeof runs[number])=>run.closing??=(async()=>{
  await run.app.evaluate(({app})=>{const original=(globalThis as any).__d3Quit;if(original)app.quit=original;}).catch(()=>{});
  await Promise.race([run.app.close().catch(()=>{}),pause(5000)]);
  for(const pid of await matchingPids()){try{process.kill(pid,'SIGTERM');}catch{}}
  const end=Date.now()+3000;while((await matchingPids()).length&&Date.now()<end)await pause(50);
  for(const pid of await matchingPids()){try{process.kill(pid,'SIGKILL');}catch{}}
 })();
 const checkpoint=(status:string,remainingPids:number[]|null=null)=>writeProbeCheckpoint(join(evidence,'proof.json'),{passed:completed&&!failure&&status==='complete',status,sourceCommit:process.env.BOTLING_TEST_SOURCE_COMMIT,startedAt,at:Date.now(),phase,label,baseline:proof.baseline,samples:proof.samples,windows:proof.windows,trace,failure:failure?{message:failure.message,stack:failure.stack}:null,finalizationErrors,remainingPids,runs:runs.map(run=>({label:run.label,runtime:run.runtime,process:run.receipt()})),data,normalData,root,scope:'two narrow D3 stages: recovery cancellation/reuse and independent normal counter; trusted CDP versus DOM activation labeled separately; no E3/input tracing'},current?.receipt);
 const fail=(error:unknown)=>{if(!failure){failure=error instanceof Error?error:new Error(String(error));try{checkpoint('failed');}catch{}abort();if(current)void closeRun(current).catch(()=>{});}};
 const guarded=async<T>(promise:Promise<T>)=>Promise.race([promise,aborted.then(()=>{throw failure!;})]);
 const start=async(nextLabel:string,runData=data)=>{
  label=nextLabel;note('launch.begin');
  const task=launch({dataDir:runData,waitForState:false,args:['--botling-update-data='+runData],env:{BOTLING_HIDDEN:'1',BOTLING_TEST_TRACE:'0'},onLaunched:async app=>{
   const run={label:nextLabel,app,receipt:captureProcessReceipt(app),runtime:null as any};runs.push(run);current=run;
   if(failure){await closeRun(run);throw failure;}
   const observePage=(page:Page)=>page.on('console',message=>{
    if(message.text().startsWith('d3-observe:')){try{note('renderer',{record:JSON.parse(message.text().slice(11))});}catch(error){fail(error);}}
   });
   app.context().on('page',observePage);for(const page of app.context().pages())observePage(page);
   await app.context().addInitScript(observeD3Document);
   run.runtime=await app.evaluate(({app,BrowserWindow,ipcMain})=>{
    const records:any[]=[];(globalThis as any).__d3Native=records;const emit=(event:string,data:any={})=>records.push({at:Date.now(),event,...data});
    const ids=new Set<string>();ipcMain.on('botling:post',(event,raw)=>{if(raw?.cmd?.type==='card.save'){ids.add(String(raw.id));emit('core.card.save.ipc',{id:raw.id,cmd:raw.cmd,contents:event.sender.id,frame:event.senderFrame?.routingId});}});
    const watch=(window:InstanceType<typeof BrowserWindow>)=>{
     emit('window.observed',{id:window.id,contents:window.webContents.id,visible:window.isVisible(),focused:window.isFocused()});
     window.on('show',()=>emit('show',{id:window.id}));window.on('focus',()=>emit('focus',{id:window.id}));window.on('closed',()=>emit('window.closed',{id:window.id}));
     const wc=window.webContents,send=wc.send.bind(wc);wc.send=((channel:string,...args:any[])=>{const value=args[0];if(channel==='botling:message'&&(value?.event?.type==='card.updated'||ids.has(String(value?.id))))emit('core.reply',{payload:value});return send(channel,...args);}) as typeof wc.send;
     wc.on('will-navigate',(_e,url)=>emit('frame.will-navigate',{url:url.startsWith('data:')?'data:recovery':url}));
     wc.on('did-frame-finish-load',(_e,main,processId,routingId)=>emit('frame.finish',{main,processId,routingId}));
     wc.on('did-frame-navigate',(_e,url,status,_text,main,processId,routingId)=>emit('frame.navigate',{url:url.startsWith('data:')?'data:recovery':url,main,status,processId,routingId}));
    };for(const window of BrowserWindow.getAllWindows())watch(window);app.on('browser-window-created',(_e,window)=>watch(window));
    return{pid:process.pid,execPath:process.execPath,hidden:process.env.BOTLING_HIDDEN,agent:process.env.BOTLING_AGENT,userData:app.getPath('userData'),traceEnabled:process.env.BOTLING_TEST_TRACE};
   });
   for(const page of app.context().pages())for(const frame of page.frames())await frame.evaluate(observeD3Document).catch(()=>{});
   expect(run.runtime.hidden).toBe('1');expect(run.runtime.agent).toBe('fake');expect(run.runtime.execPath).toBe(executable);
  }});launchTask=task;void task.catch(()=>{});return guarded(task);
 };
 const activate=async(locator:Locator,page:Page,name:string,businessDone:()=>Promise<boolean>)=>{
  const measure=()=>locator.evaluate(el=>{const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return{rect:{x:r.x,y:r.y,width:r.width,height:r.height},point:{x,y},viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY},hit:hit?{tag:hit.nodeName,id:hit.id,text:hit.closest('a,button')?.textContent}:null,targetHit:!!hit&&(hit===el||el.contains(hit)),documentGeneration:performance.timeOrigin};});
  const before=await guarded(measure());note('delivery.geometry.before',{name,geometry:before});
  const inside=(g:typeof before)=>g.point.x>=0&&g.point.y>=0&&g.point.x<g.viewport.width&&g.point.y<g.viewport.height&&g.targetHit;
  if(!inside(before)){await guarded(locator.scrollIntoViewIfNeeded({timeout:3000}));note('harness.scrollIntoView',{name});}
  const geometry=await guarded(measure()),globalRect=await guarded(locator.boundingBox());note('delivery.geometry.ready',{name,geometry,globalRect});
  expect(inside(geometry),'Input requires a visible viewport hit target').toBe(true);expect(globalRect).not.toBeNull();
  const trusted=()=>trace.filter(entry=>entry.event==='renderer'&&entry.label===label&&entry.record?.event==='dom.click'&&entry.record.data?.trusted&&(entry.record.data.action?.id===name||entry.record.data.action?.text===name)).length;
  const count=trusted();note('activation.cdp',{name,point:{x:globalRect!.x+globalRect!.width/2,y:globalRect!.y+globalRect!.height/2}});
  await guarded(page.mouse.click(globalRect!.x+globalRect!.width/2,globalRect!.y+globalRect!.height/2));
  let nativeReceipt=true;try{await guarded(expect.poll(()=>trusted()>count,{timeout:1000,intervals:[50,100,200]}).toBe(true));}catch(error){if(failure)throw failure;nativeReceipt=false;}
  const done=await guarded(businessDone());note('delivery.cdp.result',{name,trustedClickReceived:nativeReceipt,businessAlreadyDone:done});
  if(!nativeReceipt&&!done){note('activation.dom',{name,trust:'programmatic/untrusted; action-business-logic only'});await guarded(locator.evaluate(el=>(el as HTMLElement).click()));return 'DOM';}
  return nativeReceipt?'trusted-CDP':'CDP-business-receipt-only';
 };

 try{
  const initial=await frontmost(),at=Date.now();proof.sample(initial,'before',at,at);checkpoint('running');
  monitor=(async()=>{while(!stop&&!failure){const at=Date.now(),samplePhase=phase;
   try{proof.sample(await frontmost(),samplePhase,at,Date.now());}catch(error){metadataFailed=true;fail(error);break;}
   if(current&&!current.closing){const run=current;let snapshot:any;
    try{snapshot=await run.app.evaluate(({BrowserWindow})=>({states:BrowserWindow.getAllWindows().map(w=>({id:w.id,visible:w.isVisible(),focused:w.isFocused()})),journal:(globalThis as any).__d3Native??[]}));}catch(error){if(!run.closing){fail(error);break;}}
    if(snapshot){try{proof.window(Date.now(),snapshot.states,snapshot.journal);}catch(error){fail(error);break;}note('native.snapshot',{run:run.label,pid:run.runtime?.pid,...snapshot});}
   }
   try{checkpoint('running');if(Date.now()-startedAt>25000)throw new Error('D3 bounded runtime exceeded 25 seconds');}catch(error){fail(error);break;}
   await pause(100);
  }})();
  await guarded(pause(300));phase='during';
  const recovery=await start('recovery');await guarded(recovery.page.getByRole('link',{name:'Delete recovery copies…'}).waitFor({state:'visible'}));
  await recovery.app.evaluate(({app,dialog,shell})=>{(globalThis as any).__d3Actions=[];(globalThis as any).__d3Quit=app.quit;
   dialog.showMessageBox=(async()=>{(globalThis as any).__d3Actions.push({at:Date.now(),confirmation:'keep'});return{response:0,checkboxChecked:false};}) as typeof dialog.showMessageBox;
   shell.openPath=async path=>{(globalThis as any).__d3Actions.push({at:Date.now(),open:path});return '';};app.relaunch=options=>{(globalThis as any).__d3Actions.push({at:Date.now(),relaunch:options});};app.quit=()=>{(globalThis as any).__d3Actions.push({at:Date.now(),quit:true});};
  });
  const before=await recovery.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({id:w.id,contents:w.webContents.id}))),generation=await recovery.page.evaluate(()=>performance.timeOrigin);note('recovery.identity.before',{before,generation});
  const recoveryMethod=await activate(recovery.page.getByRole('link',{name:'Delete recovery copies…',exact:true}),recovery.page,'Delete recovery copies…',()=>recovery.app.evaluate(()=>(globalThis as any).__d3Actions.some((a:any)=>a.confirmation)));
  await guarded(expect.poll(()=>recovery.app.evaluate(()=>(globalThis as any).__d3Actions.filter((a:any)=>a.confirmation).length)).toBe(1));
  await guarded(expect.poll(()=>recovery.page.evaluate(generation=>performance.timeOrigin!==generation&&document.body.innerText.includes('Delete recovery copies…')&&!document.body.innerText.includes('Inspecting retained copies…'),generation)).toBe(true));
  const after=await recovery.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({id:w.id,contents:w.webContents.id})));expect(after).toEqual(before);expect(recovery.page.isClosed()).toBe(false);expect(existsSync(join(root,'data-before'))).toBe(true);note('recovery.identity.after',{after,method:recoveryMethod,generation:await recovery.page.evaluate(()=>performance.timeOrigin)});await guarded(recovery.page.screenshot({path:join(evidence,'recovery-redraw.png')}));
  note('recovery.actions',{actions:await recovery.app.evaluate(()=>(globalThis as any).__d3Actions)});
  note('native.final',{run:current!.label,journal:await recovery.app.evaluate(()=>(globalThis as any).__d3Native)});await closeRun(current!);checkpoint('running');
  const normal=await start('normal',normalData);await guarded(normal.page.locator('.shell[data-ready="1"]').waitFor());
  const chat=await guarded(chatFrame(normal.page));await guarded(chat.waitForFunction(()=>!!(window as any).__botlingBroker));await guarded(chat.evaluate(observeD3Document));
  const counter=normal.chat.frameLocator('[data-card="c-counter"] iframe');await guarded(counter.locator('#add').waitFor({state:'visible'}));
  for(const frame of normal.page.frames())if(frame.url().startsWith('botling-card://card/'))await guarded(frame.evaluate(observeD3Document));
  writeFileSync(join(evidence,'chat-before.json'),readFileSync(join(normalData,'core/main/chat.json')));const counterMethod=await activate(counter.locator('#add'),normal.page,'add',()=>chat.evaluate(()=>(window as any).__botlingBroker.accepted.some((a:any)=>a.kind==='save')));note('counter.activation.method',{method:counterMethod});
  await guarded(expect(counter.locator('#n')).toHaveText('1',{timeout:5000}));
  await guarded(expect.poll(()=>JSON.parse(readFileSync(join(normalData,'core/main/chat.json'),'utf8')).find((m:any)=>m.cards?.some((c:any)=>c.id==='c-counter')).cards.find((c:any)=>c.id==='c-counter').data).toBe('{"count":1}'));
  note('counter.persisted',{chat:JSON.parse(readFileSync(join(normalData,'core/main/chat.json'),'utf8'))});await guarded(normal.page.screenshot({path:join(evidence,'counter-persisted.png')}));
  const broker=await chat.evaluate(()=>({accepted:(window as any).__botlingBroker.accepted,refused:(window as any).__botlingBroker.refusals}));note('broker.final',{broker});expect(broker.accepted.filter((a:any)=>a.kind==='save')).toHaveLength(1);expect(broker.refused).toEqual([]);
  note('native.final',{run:current!.label,journal:await normal.app.evaluate(()=>(globalThis as any).__d3Native)});phase='shutdown';await closeRun(current!);writeFileSync(join(evidence,'chat-after-clean-exit.json'),readFileSync(join(normalData,'core/main/chat.json')));
  expect(await matchingPids()).toEqual([]);expect(runs.map(r=>r.receipt().exitCode)).toEqual([0,0]);completed=true;
 }catch(error){fail(error);throw error;}
 finally{
  const record=(stage:string,error:unknown)=>{const cause=error instanceof Error?error:new Error(String(error));finalizationErrors.push({stage,message:cause.message});failure??=cause;};let remaining:number[]|null=null;
  try{try{for(const run of runs)await closeRun(run).catch(error=>record('shutdown',error));}finally{stop=true;await monitor?.catch(error=>record('monitor',error));await launchTask?.catch(error=>record('launch',error));}}
  finally{try{remaining=await matchingPids();if(remaining.length)record('inventory',new Error('Isolated processes remain'));}catch(error){record('inventory',error);}finally{
   try{
    if(remaining?.length===0&&runs.every(run=>run.receipt().exitCode!==null||run.receipt().signalCode!==null)&&!metadataFailed){
     phase='after';label='after';
     for(let i=0;i<2;i++){const at=Date.now();try{proof.sample(await frontmost(),'after',at,Date.now());checkpoint('running',remaining);}catch(error){record('after-sampling',error);break;}if(i===0)await pause(100);}
    }else note('after.sampling.skipped',{remaining,metadataFailed});
    if(completed&&!failure){try{proof.complete();}catch(error){record('proof-complete',error);}}
   }finally{
   try{if(existsSync(join(normalData,'core/main/chat.json')))writeFileSync(join(evidence,'final-chat.json'),readFileSync(join(normalData,'core/main/chat.json')));}catch(error){record('diagnostics',error);}
   try{rmSync(root,{recursive:true,force:true});}catch(error){record('stage-cleanup',error);}finally{try{rmSync(data,{recursive:true,force:true});}catch(error){record('data-cleanup',error);}finally{try{rmSync(normalData,{recursive:true,force:true});}catch(error){record('counter-cleanup',error);}finally{try{checkpoint(completed&&!failure?'complete':'failed',remaining);}catch(error){record('checkpoint',error);}}}}
  }}}if(failure)throw failure;
 }
});
