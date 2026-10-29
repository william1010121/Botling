import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Bot} from '../../../src/core/bot';
import {botPrompts} from '../../../src/core/prompts';
import {ProcessLedger} from '../../../src/core/process/ledger';
import type {BotProfile} from '../../../src/core/store/workspace';

export const cases = {
 write: 'Delegate exactly one agy worker to use botling write_file exactly once: path="allow-marker.txt", content="ALLOWED". It must stop after denial and must not use other tools. Scope contract: {"deliverables":["private marker write"],"phase":"implementation","implementation_authorized":true,"implementation_files":["allow-marker.txt"],"file_release_authorizes_implementation":false}. After its report, request app_task_checkpoint for that exact task_id/run with outcome complete only if its evidence confirms that exact write; otherwise blocked with the reason. Do not use another engine or perform unrelated work.',
 command: 'Delegate exactly one agy worker to use botling run_command exactly once with command="sleep 30" in the supplied private scratch directory. Do not write files or run other commands. Scope contract: {"deliverables":["bounded cancellation fixture"],"phase":"implementation","implementation_authorized":true,"implementation_files":[],"file_release_authorizes_implementation":false}. The human will cancel this staging run after approving the command. A denial is final. Do not retry, change permissions, or launch another task.',
} as const;
export type CaseName=keyof typeof cases;

/** Real Bot lifecycle and approval callbacks. No fabricated permission or grant. */
export class StagingController {
 readonly bot:Bot;
 readonly workspace:string;
 readonly ledger:ProcessLedger;
 private started=new Set<CaseName>();
 private closed=false;
 private closing?:Promise<void>;
 private deadline?:ReturnType<typeof setTimeout>;
 readonly evidence:{at:string;event:string;detail?:unknown}[]=[];
 constructor(readonly root:string,command:string,private check:()=>void,notify:()=>void){
  this.workspace=join(root,'workspace');const storeDir=join(root,'store');
  mkdirSync(this.workspace,{recursive:true});mkdirSync(storeDir,{recursive:true});
  const profile:BotProfile={id:randomUUID(),name:'ACP acceptance scratch',role:'bot',folder:this.workspace,storeDir,memoryPath:'.bot/memory.md',avatar:'circle',tools:[],job:null,problem:null};
  writeFileSync(join(storeDir,'bot.json'),JSON.stringify({engine:'agy',heads:{engines:['agy'],answerWith:'agy'}}));
  this.ledger=new ProcessLedger(join(root,'process-ledger.json'));
  this.bot=new Bot({profile,deferStartup:true,welcome:false,ledger:this.ledger,
   launch:()=>({autoMode:false,agyBypassPermissions:false,claudeBypassPermissions:false,codexBypassPermissions:false,subagentHourCache:false}),
   headConfig(){throw Error('Only ACP is available in this staging runner');},
   agyConfig:(_p,config)=>({...config,command,transport:'acp',acpHome:join(root,'acp-profile'),bypassPermissions:false}),
   prompts:(engine,heads)=>botPrompts({profile,engine,heads,results:'localOnly'}),
   emit:event=>{this.evidence.push({at:new Date().toISOString(),event:event.type});notify();},
   log:()=>{},approvalTimeoutMs:120_000,idleMs:24*60*60_000,interruptGraceMs:1_000,
  });
 }
 snapshot(){return {chat:this.bot.snapshot(),root:this.root,workspace:this.workspace,closed:this.closed,started:[...this.started],marker:existsSync(join(this.workspace,'allow-marker.txt'))?readFileSync(join(this.workspace,'allow-marker.txt'),'utf8'):null};}
 start(name:CaseName){
  if(this.closed||!(name in cases)||this.started.size>0)throw Error('Case unavailable or already started');
  const chat=this.bot.snapshot();if(chat.running||chat.messages.some(m=>m.approval&&m.chosen==null&&m.answer==null))throw Error('Resolve current run and approval cards first');
  this.check(); // runtime + existing-account metadata; never starts login
  this.deadline=setTimeout(()=>{void this.close().catch(error=>{this.evidence.push({at:new Date().toISOString(),event:'cleanup-failed',detail:String(error)});});},300_000);
  this.started.add(name);this.evidence.push({at:new Date().toISOString(),event:'human-start-case',detail:name});
  return this.bot.send(cases[name],{to:'agy'});
 }
 choose(messageId:string,index:number){
  const card=this.bot.snapshot().messages.find(m=>m.id===messageId);
  if(this.closed||!card?.approval||!card.choices?.[index]||card.chosen!=null||card.answer!=null)throw Error('No current approval card matches this choice');
  this.evidence.push({at:new Date().toISOString(),event:'human-card-choice',detail:{messageId,index}});
  return this.bot.choose(messageId,index);
 }
 close(){
  if(this.closing)return this.closing;
  this.closed=true;
  clearTimeout(this.deadline);
  return this.closing=this.finishClose();
 }
 private async finishClose(){
  await this.bot.shutdown({tidy:false});
  // Production ledger recovery checks start identities; only this private run's entries.
  const stopped=this.ledger.endLeftovers();
  this.evidence.push({at:new Date().toISOString(),event:'shutdown',detail:{ledgerGroupsStopped:stopped}});
  writeFileSync(join(this.root,'evidence.json'),JSON.stringify({events:this.evidence,snapshot:this.snapshot()},null,2));
 }
}
