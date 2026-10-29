/** UI verification only: no Bot, ACP, auth, subprocess, grant or approval object. */
export class SafeController {
 readonly workspace='UI verification — no workspace writes';
 readonly calls={start:0,cancel:0};
 rejectNextStart=false;
 private started:string[]=[];
 private closed=false;
 constructor(readonly root:string){}
 snapshot(){return {chat:{messages:[],running:null},root:this.root,workspace:this.workspace,started:this.started,closed:this.closed,marker:null,safe:true,calls:{...this.calls}};}
 async start(name:string){
  this.calls.start++;
  await new Promise(resolve=>setTimeout(resolve,250));
  if(this.rejectNextStart){this.rejectNextStart=false;throw Error('UI verification: intentional prerequisite failure');}
  if(this.closed)throw Error('UI verification closed');
  this.started=[name];return {accepted:true};
 }
 choose():never {throw Error('Approvals unavailable in UI verification mode');}
 async close(){if(!this.closed)this.calls.cancel++;this.closed=true;}
}
