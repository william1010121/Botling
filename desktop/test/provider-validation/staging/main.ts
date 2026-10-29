import {app,BrowserWindow,ipcMain} from 'electron';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyAcpRuntime} from '../../../src/core/agent/agy-acp';
import {verifyAgyFileHelper} from '../../../src/core/agent/agy-mcp';
import {StagingController,type CaseName} from './controller';
import {SafeController} from './safe-controller';
import {checkUI} from './ui-regression';

const manifest=JSON.parse(readFileSync(join(__dirname,'manifest.json'),'utf8'));
const base=join(__dirname,'runs');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'run-'));
app.setName('Botling ACP Acceptance');app.setPath('userData',join(root,'electron'));
const page=pathToFileURL(join(__dirname,'index.html')).href;
const safe=process.argv.includes('--ui-preview')||process.argv.includes('--ui-regression');
const regression=process.argv.includes('--ui-regression');
let window:BrowserWindow,controller:StagingController|SafeController|undefined;
let quit=false,closing=false;
function checkRuntime(){
 verifyAcpRuntime(manifest.acpCommand);
 verifyAgyFileHelper(join(dirname(manifest.acpCommand),'botling-agy-file-helper'),join(root,'workspace'));
 try{execFileSync('/usr/bin/security',['find-generic-password','-s','gemini','-a','antigravity-acp'],{stdio:'ignore'});}
 catch{throw Error('Existing official ACP authentication metadata is unavailable. No provider started. Do not initiate login here; use the separately reviewed login command only after explicit authorization.');}
}
app.whenReady().then(()=>{
 window=new BrowserWindow({width:660,height:560,show:false,title:'ACP acceptance — isolated candidate',webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,partition:'acy-staging-'+Date.now()}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',(event,url)=>{if(url!==page)event.preventDefault();});
 controller=safe?new SafeController(root):new StagingController(root,manifest.acpCommand,checkRuntime,()=>{if(window&&!window.isDestroyed())window.webContents.send('stage:changed');});
 const validate=(event:Electron.IpcMainInvokeEvent)=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==page)throw Error('Foreign staging IPC');};
 ipcMain.handle('stage:snapshot',event=>{validate(event);return {...controller!.snapshot(),manifest};});
 ipcMain.handle('stage:start',(event,name:CaseName)=>{validate(event);if(name!=='write'&&name!=='command')throw Error('Unknown case');return controller!.start(name);});
 ipcMain.handle('stage:choose',(event,id:string,index:number)=>{validate(event);if(typeof id!=='string'||!Number.isInteger(index)||index<0||index>19)throw Error('Invalid choice');return controller!.choose(id,index);});
 ipcMain.handle('stage:cancel',async event=>{validate(event);await controller!.close();window.webContents.send('stage:changed');return {closed:true};});
 window.on('close',event=>{if(quit)return;event.preventDefault();if(closing)return;closing=true;void controller!.close().then(()=>{quit=true;window.destroy();app.quit();}).catch(error=>{closing=false;window.webContents.send('stage:error',String(error));});});
 writeFileSync(join(root,'run.json'),JSON.stringify({candidate:manifest.commit,root,sharedAppTouched:false},null,2));
 window.webContents.on('preload-error',(_event,_path,error)=>{writeFileSync(join(root,'ui-error.txt'),String(error));});
 void window.loadURL(page).then(async()=>{
  window.show();
  if(regression){
   try{const result=await checkUI(window,controller as SafeController);writeFileSync(join(__dirname,'ui-regression.json'),JSON.stringify(result));console.log(JSON.stringify(result));}
   catch(error){writeFileSync(join(__dirname,'ui-regression.json'),JSON.stringify({passed:false,error:String(error)}));console.error(String(error));process.exitCode=1;}
   finally{await controller!.close();quit=true;window.destroy();app.exit(Number(process.exitCode??0));}
  }
 });
});
app.on('before-quit',event=>{if(!quit&&window&&!window.isDestroyed()){event.preventDefault();window.close();}});
app.on('window-all-closed',()=>{if(quit)app.quit();});
