import {afterEach,expect,it} from 'vitest';
import {mkdirSync,readFileSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tempDir,desktop} from '../helpers';
import type {TestTraceRecord} from '../../src/test-trace';
const bases:string[]=[];afterEach(()=>{for(const path of bases.splice(0))rmSync(path,{recursive:true,force:true});});
const module=()=>import('../../src/main/input-trace');
function fixture(){const data=tempDir('trace-main');bases.push(data);const marker={v:1,fixture:'composer-race',runId:'run-10',testId:'synthetic-probe',focusEmulation:'requested-on'};writeFileSync(join(data,'.botling-synthetic-test.json'),JSON.stringify(marker));return{data,options:{packaged:false,dataDir:data,syntheticBase:join(desktop,'.cache/test-data'),env:{BOTLING_TEST_TRACE:'1',BOTLING_AGENT:'fake',BOTLING_HIDDEN:'1',BOTLING_DATA_DIR:data}}};}
const sender={owned:true,isMainFrame:true,url:'app://botling/index.html',contentsId:12,processId:34,routingId:56};
const sample=(seq=1):TestTraceRecord=>({v:1,scope:'chat',generation:'chat:123000',timeOrigin:123000,at:123000.25,seq,event:'dom.input',data:{text:'synthetic 中文'}});
it('trace authority requires unpackaged + hidden fake agent + explicit owned disposable marker, not an argument',async()=>{
 const m=await module(),f=fixture();expect(m.syntheticTraceContext(f.options)).not.toBeNull();
 for(const change of [{packaged:true},{env:{...f.options.env,BOTLING_TEST_TRACE:'0'}},{env:{...f.options.env,BOTLING_AGENT:'claude'}},{env:{...f.options.env,BOTLING_HIDDEN:'0'}},{env:{...f.options.env,BOTLING_IMPORT_FROM:'/synthetic/import'}},{env:{...f.options.env,BOTLING_DATA_DIR:''}}])expect(m.syntheticTraceContext({...f.options,...change})).toBeNull();
 rmSync(join(f.data,'.botling-synthetic-test.json'));expect(m.syntheticTraceContext(f.options)).toBeNull();
});
it('trace rejects malformed/symlinked/default user data even if fake/test flags are present',async()=>{
 const m=await module(),f=fixture();writeFileSync(join(f.data,'.botling-synthetic-test.json'),'{}');expect(m.syntheticTraceContext(f.options)).toBeNull();
 const outside=join(f.data,'external');mkdirSync(outside);const link=join(f.data,'linked');symlinkSync(outside,link);expect(m.syntheticTraceContext({...f.options,dataDir:link,env:{...f.options.env,BOTLING_DATA_DIR:link}})).toBeNull();
});
it('trace sender authorization rejects cards, remote/subframes, foreign contents, credentials and forged shell URLs',async()=>{
 const m=await module();expect(m.traceSenderAllowed(sender)).toBe(true);
 for(const change of [{owned:false},{isMainFrame:false},{url:'botling-chat://chat/chat.html'},{url:'app://botling.evil/index.html'},{url:'app://user@botling/index.html'},{url:'app://botling:123/index.html'},{url:'app://botling/other.html'}])expect(m.traceSenderAllowed({...sender,...change})).toBe(false);
});
it('writer preserves renderer clocks/sequence, records arrival identity, and drains footer before close',async()=>{
 const m=await module(),f=fixture(),context=m.syntheticTraceContext(f.options)!;const writer=await m.InputTraceWriter.open(context);const record=sample();expect(writer.accept(record,sender)).toBe(true);expect(writer.accept({...record,event:'card.iframe.load'},sender)).toBe(true);await writer.close();
 const rows=readFileSync(join(f.data,'input-trace.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));expect(rows[0]).toMatchObject({kind:'header',runId:'run-10',testId:'synthetic-probe',focusEmulation:'requested-on'});expect(rows[1]).toMatchObject({kind:'renderer',writerSeq:2,contentsId:12,processId:34,routingId:56,record});expect(rows[1].receivedAt).toBeGreaterThan(record.at);expect(rows.at(-1)).toMatchObject({kind:'end',dropped:0});expect(writer.accept(sample(2),sender)).toBe(false);
});
it('main writer rechecks synthetic identity and refuses malformed/oversized/unowned input without persisting it',async()=>{
 const m=await module(),f=fixture(),writer=await m.InputTraceWriter.open(m.syntheticTraceContext(f.options)!);
 expect(writer.accept(sample(),{...sender,owned:false})).toBe(false);expect(writer.accept({...sample(),data:{text:'x'.repeat(300000)}},sender)).toBe(false);rmSync(join(f.data,'.botling-synthetic-test.json'));expect(writer.accept(sample(),sender)).toBe(false);await writer.close();expect(readFileSync(join(f.data,'input-trace.jsonl'),'utf8')).not.toContain('synthetic 中文');
});
it('bounded writer reports dropped queue/file records and never exceeds its file limit',async()=>{
 const m=await module(),f=fixture(),writer=await m.InputTraceWriter.open(m.syntheticTraceContext(f.options)!,{maxFileBytes:2048,maxQueueBytes:512});
 for(let seq=1;seq<100;seq++)writer.accept(sample(seq),sender);await writer.close();const bytes=readFileSync(join(f.data,'input-trace.jsonl'));expect(bytes.length).toBeLessThanOrEqual(2048);const footer=JSON.parse(bytes.toString().trim().split('\n').at(-1)!);expect(footer.kind).toBe('end');expect(footer.dropped).toBeGreaterThan(0);expect(footer.truncated).toBe(true);
});
it('writer never follows or overwrites an existing/symlinked trace destination',async()=>{
 const m=await module(),f=fixture(),context=m.syntheticTraceContext(f.options)!;const outside=join(f.data,'keep');writeFileSync(outside,'keep');symlinkSync(outside,join(f.data,'input-trace.jsonl'));await expect(m.InputTraceWriter.open(context)).rejects.toThrow();expect(readFileSync(outside,'utf8')).toBe('keep');
});
it('writer refuses real/default paths and stops when its fake-agent environment is revoked',async()=>{
 const m=await module(),f=fixture();expect(m.syntheticTraceContext({...f.options,dataDir:'/synthetic-home/.claudecodebot',env:{...f.options.env,BOTLING_DATA_DIR:'/synthetic-home/.claudecodebot'}})).toBeNull();const writer=await m.InputTraceWriter.open(m.syntheticTraceContext(f.options)!);f.options.env.BOTLING_AGENT='claude';expect(writer.accept(sample(),sender)).toBe(false);await writer.close();expect(readFileSync(join(f.data,'input-trace.jsonl'),'utf8')).not.toContain('synthetic 中文');
});
it('main observations retain epoch time and frame identity without an Electron process',async()=>{
 const m=await module(),f=fixture(),writer=await m.InputTraceWriter.open(m.syntheticTraceContext(f.options)!);expect(writer.observe('native.frame.loaded',{contentsId:12,processId:34,routingId:56})).toBe(true);await writer.close();const rows=readFileSync(join(f.data,'input-trace.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));expect(rows[1]).toMatchObject({kind:'main',event:'native.frame.loaded',data:{contentsId:12,processId:34,routingId:56}});expect(rows[1].at).toBeGreaterThan(0);
});
it('a disposed IPC sender frame cannot throw diagnostics into the app lifecycle',async()=>{const m=await module(),f=fixture(),writer=await m.InputTraceWriter.open(m.syntheticTraceContext(f.options)!);expect(typeof m.acceptTraceIPC).toBe('function');expect(m.acceptTraceIPC(writer,()=>{throw new Error('disposed frame');},sample())).toBe(false);await writer.close();});
