import {lstatSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {join,sep} from 'node:path';
import {desktop} from './helpers';
import {syntheticTraceContext} from '../src/main/input-trace';
export interface TraceFixture {runId:string;testId:string;focusEmulation?:boolean}
/** Explicit source-test capability only. Never label a default/imported user directory synthetic. */
export function prepareTraceFixture(dataDir:string,env:Record<string,string>,trace?:TraceFixture):void {
 if(!trace){if(env.BOTLING_TEST_TRACE==='1')throw new Error('Tracing requires an explicit synthetic trace fixture');return;}
 if(env.BOTLING_HIDDEN!=='1'||env.BOTLING_AGENT!=='fake'||env.BOTLING_IMPORT_FROM||env.BOTLING_1X_DIR)throw new Error('Trace fixtures require hidden fake-agent runs without imported data');
 const base=realpathSync(join(desktop,'.cache/test-data'));
 if(!base.startsWith('/Volumes/My-SSD/')||!dataDir.startsWith(base+sep)||realpathSync(dataDir)!==dataDir||lstatSync(dataDir).isSymbolicLink())throw new Error('Trace fixture must be an isolated synthetic data directory');
 const marker=join(dataDir,'.botling-synthetic-test.json');
 writeFileSync(marker,JSON.stringify({v:1,fixture:'composer-race',runId:trace.runId,testId:trace.testId,focusEmulation:trace.focusEmulation===false?'requested-off':'requested-on'}),{flag:'wx',mode:0o600});
 env.BOTLING_TEST_TRACE='1';
 if(!syntheticTraceContext({packaged:false,dataDir,syntheticBase:base,env})){rmSync(marker);throw new Error('Invalid synthetic trace fixture');}
}
