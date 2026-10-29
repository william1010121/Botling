// User-invoked ONLY. Speaks the official ACP authenticate method; never sends a model task.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {verifyAcpRuntime} from '../../../src/core/agent/agy-acp';
import {processTreeAdapter} from '../../../src/core/process/tree';

async function login(){
 if(!process.argv.includes('--user-authorized-login'))throw Error('No login started. This command requires the user to explicitly authorize official ACP login.');
 const manifest=JSON.parse(readFileSync(join(__dirname,'manifest.json'),'utf8'));
 verifyAcpRuntime(manifest.acpCommand);
 const home=join(__dirname,'login-profile');mkdirSync(home,{recursive:true,mode:0o700});
 const env:NodeJS.ProcessEnv={GEMINI_HOME:home};for(const k of ['HOME','PATH','USER','TMPDIR','LANG'])if(process.env[k])env[k]=process.env[k];
 const processGroup=processTreeAdapter().spawn(manifest.acpCommand,[],{cwd:home,env});
 const child=processGroup.child;child.stderr?.resume(); // Never print OAuth URLs, codes or account data.
 let buffer='';let settled=false;let timer:ReturnType<typeof setTimeout>;
 const result=await new Promise<string>(resolve=>{
  const finish=(status:string)=>{if(!settled){settled=true;resolve(status);}};
  timer=setTimeout(()=>finish('timeout'),300_000);
  child.on('error',()=>finish('runtime-error'));child.on('exit',()=>finish('exited'));
  process.once('SIGINT',()=>finish('cancelled'));process.once('SIGTERM',()=>finish('cancelled'));
  child.stdout?.setEncoding('utf8');child.stdout?.on('data',(chunk:string)=>{
   buffer+=chunk;if(buffer.length>2_000_000){finish('oversize-response');return;}
   let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let m:any;try{m=JSON.parse(line);}catch{finish('invalid-response');return;}
    if(m.error){finish('official-authentication-failed');return;}
    if(m.id===1){if(m.result?.agentInfo?.name!=='antigravity-acp'||m.result.agentInfo.version!=='1.4.3'){finish('unverified-runtime');return;}
     child.stdin?.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'authenticate',params:{methodId:'oauth-personal'}})+'\n');
    }else if(m.id===2){finish(m.result!==undefined?'authenticated':'invalid-response');}
    else if(m.method&&m.id!==undefined){child.stdin?.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Login-only client does not perform actions'}})+'\n');}
   }
  });
  child.stdin?.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'Botling-user-authorized-login',version:'1'}}})+'\n');
 });
 clearTimeout(timer!);await processGroup.terminate({graceMs:1500});
 writeFileSync(join(home,'login-result.json'),JSON.stringify({status:result,modelTasksSubmitted:0,credentialContentsRead:false,time:new Date().toISOString()},null,2));
 console.log(`Official ACP login: ${result}. No model task submitted.`);if(result!=='authenticated')process.exitCode=1;
}
void login().catch(error=>{console.error(error instanceof Error?error.message:'Login failed');process.exitCode=1;});
