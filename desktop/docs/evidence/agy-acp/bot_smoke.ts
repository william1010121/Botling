import {Bot} from '../../../src/core/bot';
import {botPrompts} from '../../../src/core/prompts';
import {ProcessLedger} from '../../../src/core/process/ledger';
import {mainProfile} from '../../../src/core/store/workspace';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const root=resolve('.cache/agy-acp-dev'),dir=mkdtempSync(join(root,'bot-smoke-')),cwd=join(dir,'workspace');mkdirSync(cwd);
const profile=mainProfile(cwd),evidence:any={cards:[],turns:[]};let finished!:(value:any)=>void;
function make(){return new Bot({profile,deferStartup:true,welcome:false,ledger:new ProcessLedger(join(dir,'ledger.json')),headConfig(){throw Error('No other engine permitted in this probe');},agyConfig(_p,c){return {...c,transport:'acp',command:join(root,'server/agy_acp_server.par'),acpHome:join(dir,'profile')};},prompts:(engine,heads)=>botPrompts({profile,engine,heads}),emit:e=>{if(e.type==='turn.finished')finished?.(e);},log(){},approvalTimeoutMs:10_000,idleMs:600_000,interruptGraceMs:1000});}
async function send(b:Bot,text:string){
 const completed=new Promise<any>(r=>finished=r);const result=b.send(text);
 const seen=new Set<string>(),timer=setInterval(()=>{for(const message of b.snapshot().messages){if(message.approval&&!seen.has(message.id)&&message.choices?.length){seen.add(message.id);evidence.cards.push({tool:message.approval.tool,choices:message.choices.map(c=>c.label)});b.choose(message.id,1);}}},50);
 const timeout=setTimeout(()=>finished({error:'timeout'}),90_000);
 const terminal=await completed;clearInterval(timer);clearTimeout(timeout);evidence.turns.push({turnId:result.turnId,terminal});return terminal;
}
let bot=make();
try{
 await bot.setHeads(['agy']);evidence.selection=bot.settingsView().engines;
 await send(bot,'Use botling write_file to create denied-core.txt containing hello. If permission is denied stop immediately without retry.');
 if(!evidence.cards.length||existsSync(join(cwd,'denied-core.txt')))throw Error('Core approval denial failed');
 const first=JSON.parse(readFileSync(join(profile.storeDir,'bot.json'),'utf8')).agyConversation;
 await bot.shutdown({tidy:false});bot=make();
 await send(bot,'Reply exactly BOTLING_ACP_CORE_RESUMED without using tools.');
 const second=JSON.parse(readFileSync(join(profile.storeDir,'bot.json'),'utf8')).agyConversation;
 if(first!==second||!bot.snapshot().messages.some(m=>m.text.includes('BOTLING_ACP_CORE_RESUMED')&&m.role==='bot'))throw Error('Core restart continuation failed');
 evidence.sameConversationAfterRestart=true;evidence.markerAbsent=true;evidence.passed=true;
}finally{await bot.shutdown({tidy:false});writeFileSync(join(root,'bot-smoke-results.json'),JSON.stringify(evidence,null,2));}
console.log('PASS Bot engine selection, approval cards, deny, reconstruction and continuation');
