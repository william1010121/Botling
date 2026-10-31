import {afterEach,expect,it} from 'vitest';
import {existsSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {desktop,tempDir} from '../helpers';
import {isChatURL} from '../chat-url';
import {prepareTraceFixture} from '../synthetic-trace';
import config from '../../playwright.config';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('trace chat lookup requires the exact realm/path while accepting the diagnostic query',()=>{expect(isChatURL('botling-chat://chat/chat.html?__botling_test_trace=1')).toBe(true);for(const url of ['https://other/chat.html','botling-chat://other/chat.html','botling-chat://evil@chat/chat.html','botling-chat://chat:33/chat.html','botling-chat://chat/other.html'])expect(isChatURL(url)).toBe(false);});
it.skipIf(!desktop.startsWith('/Volumes/My-SSD/'))('explicit trace fixtures stay hidden, fake, synthetic, and cannot overwrite a marker',()=>{const data=tempDir('trace-harness');dirs.push(data);const env:Record<string,string>={BOTLING_HIDDEN:'1',BOTLING_AGENT:'fake',BOTLING_DATA_DIR:data};prepareTraceFixture(data,env,{runId:'run10',testId:'harness'});expect(env.BOTLING_TEST_TRACE).toBe('1');expect(JSON.parse(readFileSync(join(data,'.botling-synthetic-test.json'),'utf8'))).toMatchObject({fixture:'composer-race',focusEmulation:'requested-on'});expect(()=>prepareTraceFixture(data,env,{runId:'other',testId:'harness'})).toThrow();});
it('hidden0, imported data and environment-only trace requests fail before launch/marker writes',()=>{const data=tempDir('trace-harness-deny');dirs.push(data);for(const extra of [{BOTLING_HIDDEN:'0',BOTLING_TEST_ALLOW_FOCUS:'1'},{BOTLING_IMPORT_FROM:'/synthetic/import'}] as Record<string,string>[])expect(()=>prepareTraceFixture(data,{BOTLING_DATA_DIR:data,BOTLING_HIDDEN:'1',BOTLING_AGENT:'fake',...extra},{runId:'run10',testId:'deny'})).toThrow();expect(()=>prepareTraceFixture(data,{BOTLING_TEST_TRACE:'1'})).toThrow();expect(existsSync(join(data,'.botling-synthetic-test.json'))).toBe(false);});
it('OS blur/focus cases remain excluded independently of the file-wide opt-in',()=>{const excluded=config.grepInvert as RegExp;expect(excluded.test('native Electron window blur leaves reselected composer editing native (350ms)')).toBe(true);expect(excluded.test('app-switch blur preserves native caret order and editing (350ms)')).toBe(true);expect(excluded.test('IME candidate text is never buffered')).toBe(false);});
it('per-page CDP mode is explicitly renderer-only and can be recorded as requested on/off',async()=>{
 const {backgroundPages}=await import('../hidden');for(const enabled of [true,false]){const sent:any[]=[],page:any={context:()=>({newCDPSession:async()=>({send:async(...args:any[])=>{sent.push(args);}})})},context:any={on:()=>{},pages:()=>[page]},app:any={context:()=>context};await backgroundPages(app,page,enabled);expect(sent).toEqual([['Emulation.setFocusEmulationEnabled',{enabled}]]);}
});
