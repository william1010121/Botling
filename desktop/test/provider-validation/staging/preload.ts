import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('stage',{
 snapshot:()=>ipcRenderer.invoke('stage:snapshot'),
 start:(name:string)=>ipcRenderer.invoke('stage:start',name),
 choose:(id:string,index:number)=>ipcRenderer.invoke('stage:choose',id,index),
 cancel:()=>ipcRenderer.invoke('stage:cancel'),
 onChange:(fn:()=>void)=>{ipcRenderer.on('stage:changed',fn);},
 onError:(fn:(message:string)=>void)=>{ipcRenderer.on('stage:error',(_event,message)=>fn(message));},
});
