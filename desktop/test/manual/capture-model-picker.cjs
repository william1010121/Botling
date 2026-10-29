// Run only with the dependency Electron binary. A hidden disposable profile; no app/core/engine startup.
const {app,BrowserWindow}=require('electron');
const {readFileSync,writeFileSync,mkdirSync}=require('node:fs');
const {resolve,join}=require('node:path');
const args=process.argv.slice(2),directory=resolve(args[0]),output=resolve(args[1]);
app.setPath('userData',join(directory,'electron-profile'));app.dock?.hide();
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:272,height:1320,enableLargerThanScreen:true,show:false,webPreferences:{backgroundThrottling:false}});
 const manifest=[];
 const capture=async(name,caption,mode)=>{
  await new Promise(r=>setTimeout(r,120));
  const picture=await win.webContents.capturePage(); writeFileSync(join(output,name),picture.toPNG());
  manifest.push({file:join(output,name),caption,mode,pixels:picture.getSize(),viewport:win.getContentSize(),environment:`Electron ${process.versions.electron}; Chromium ${process.versions.chrome}; hidden isolated settings renderer`});
 };
 const load=async(mode)=>{
  await win.loadFile(join(directory,mode+'.html'));
  await win.webContents.executeJavaScript(`document.fonts.ready.then(()=>new Promise(r=>setTimeout(r,150)))`);
  const state=await win.webContents.executeJavaScript(`({selects:document.querySelectorAll('.model-picker select').length,overflow:[...document.querySelectorAll('.model-picker')].some(e=>e.scrollWidth>e.clientWidth),customSelect:CSS.supports('appearance','base-select'),calls:window.previewCalls})`);
  if(state.selects!==4||state.overflow||!state.customSelect)throw Error(JSON.stringify(state));
 };
 try {
  await load('normal');
  await capture('01-model-settings-live-catalogs.png','Actual bot settings component with captured live Claude, Codex and ACP catalogs. Antigravity retains account default.','live catalogs; isolated UI');
  await win.webContents.executeJavaScript(`document.querySelector('.detail-panel').scrollTop=100000`);
  await capture('07-model-settings-lower.png','Normal settings, lower section: ACP default and unchanged shared reasoning.','live catalogs; isolated UI');
  for(const [index,label,slug] of [[2,"Claude's model",'claude'],[3,"Codex's model",'codex'],[4,'Antigravity model','antigravity']]){
   const point=await win.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('select')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
   win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
   await new Promise(r=>setTimeout(r,150));
   const open=await win.webContents.executeJavaScript(`[...document.querySelectorAll('select')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}).matches(':open')`);
   if(!open)throw Error('Picker did not open: '+label);
   await capture(`0${index}-${slug}-available-models.png`,`${label}: opened app-styled catalog. Data captured from the real runtime without generation.`,'live catalogs; isolated UI');
   win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  }
  await load('unavailable');await capture('05-unavailable-saved-models.png','Simulated unsupported Claude, timed-out Codex, and signed-out ACP. All saved custom IDs remain selected.','mock error/auth states');
  await win.webContents.executeJavaScript(`document.querySelector('.detail-panel').scrollTop=100000`);
  await capture('08-unavailable-lower.png','Simulated signed-out ACP with saved ID retained and Retry visible.','mock error/auth states');
  await load('loading');await capture('06-loading-models.png','Simulated pending discovery. Saved selections and engine default remain visible.','mock loading state');
  await win.webContents.executeJavaScript(`document.querySelector('.detail-panel').scrollTop=100000`);
  await capture('09-loading-lower.png','Pending discovery in the lower settings section; engine default remains selectable.','mock loading state');
  writeFileSync(join(output,'screenshots.json'),JSON.stringify({manifest,version:'source worktree bot/available-model-picker-20261029; not installed',nativeAppRestarted:false},null,2));
  console.log(JSON.stringify({ok:true,images:manifest.length}));
 } finally {win.destroy();app.quit();}
}).catch(error=>{console.error(error);app.exit(1)});
