import {writeFileSync,renameSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
export interface ProcessReceipt {pid?:number;exitCode:number|null;signalCode:string|null}
/** Capture the Node child while the Playwright dispatcher exists; never call app.process after close. */
export function captureProcessReceipt(source:{process():ProcessReceipt}):()=>ProcessReceipt {
 const child=source.process();return()=>({pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode});
}
/** Primitive checkpoint data only. A receipt failure cannot replace the original runtime failure. */
export function writeProbeCheckpoint(file:string,fields:Record<string,unknown>,receipt?:()=>ProcessReceipt):void {
 let process:ProcessReceipt|null=null,recorderError:string|undefined;
 try{process=receipt?.()??null;}catch(error){recorderError=String(error);}
 const record={...fields,process,...(recorderError?{passed:false,recorderError}:{})},temporary=file+'.'+randomUUID()+'.tmp';
 try{writeFileSync(temporary,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,file);}finally{rmSync(temporary,{force:true});}
}
