import { expect, it, vi } from 'vitest';
import { Core } from '../../src/core/server';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { desktop, tempDir } from '../helpers';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
function fixture(syncFailure=false){
  const delayed=deferred(), plugins=deferred(), teams=deferred();
  const failure=new Error('checkpoint failed');
  const core=Object.create(Core.prototype) as any;
  core.options={dataDir:tempDir('shutdown')};
  core.bots=new Map([['failed',{shutdown:()=>syncFailure?(()=>{throw failure;})():Promise.reject(failure)}],['pending',{shutdown:()=>delayed.promise}]]);
  core.options={dataDir:mkdtempSync(join(tmpdir(),'core-shutdown-'))};
  core.plugins={shutdown:vi.fn(()=>plugins.promise)};core.teams={shutdown:vi.fn(()=>teams.promise)};
  return {core,delayed,plugins,teams,failure};
}
it.each([false,true])('Core.shutdown settles every participant before rejecting (sync=%s)',async sync=>{
  const f=fixture(sync);let finished=false;
  const outcome=f.core.shutdown().then(()=>{finished=true;return null;},(e:unknown)=>{finished=true;return e;});
  await new Promise(setImmediate);expect(finished).toBe(false);
  expect(f.core.plugins.shutdown).toHaveBeenCalledOnce();expect(f.core.teams.shutdown).toHaveBeenCalledOnce();
  f.delayed.resolve();f.plugins.resolve();await new Promise(setImmediate);expect(finished).toBe(false);
  f.teams.resolve();expect(await outcome).toBeInstanceOf(Error);
});
it.each([false,true])('actual main signal boundary waits, exits once and reports failure (failure=%s)',async failed=>{
  const pending=deferred(), handlers=new Map<string,()=>void>(), exit=vi.fn(), write=vi.fn();
  const core={shutdown:vi.fn(async()=>{await pending.promise;if(failed)throw new Error('checkpoint failed');})};
  // Execute the actual entrypoint's signal wiring with inert process endpoints, never process.exit.
  const source=readFileSync(join(desktop,'src/core/main.ts'),'utf8');
  runInNewContext(source.slice(source.lastIndexOf('let quitting = false;')), {core,process:{on:(name:string,fn:()=>void)=>handlers.set(name,fn),exit,stderr:{write}}});
  handlers.get('SIGTERM')!();handlers.get('SIGINT')!();
  expect(exit).not.toHaveBeenCalled();expect(core.shutdown).toHaveBeenCalledOnce();
  pending.resolve();await new Promise(setImmediate);
  expect(exit).toHaveBeenCalledExactlyOnceWith(failed?1:0);
  if(failed)expect(write.mock.calls.flat().join('')).toContain('checkpoint failed');else expect(write).not.toHaveBeenCalled();
});

it('actual stdin-close wiring waits for Core participants and uses the shared nonzero exit boundary',async()=>{
  const f=fixture(), handlers=new Map<string,()=>void>(), exit=vi.fn(), write=vi.fn();
  const source=readFileSync(join(desktop,'src/core/main.ts'),'utf8');
  const closeStart=source.indexOf('  lines.on("close",');
  const closeLine=source.slice(closeStart,source.indexOf('\n',closeStart));
  runInNewContext(closeLine+'\n'+source.slice(source.lastIndexOf('let quitting = false;')),{
    core:f.core, lines:{on:(name:string,fn:()=>void)=>handlers.set(name,fn)},
    process:{on:(name:string,fn:()=>void)=>handlers.set(name,fn),exit,stderr:{write}},
  });
  handlers.get('close')!();handlers.get('SIGTERM')!();
  await new Promise(setImmediate);expect(exit).not.toHaveBeenCalled();
  f.delayed.resolve();f.plugins.resolve();await new Promise(setImmediate);expect(exit).not.toHaveBeenCalled();
  f.teams.resolve();await new Promise(setImmediate);
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(write.mock.calls.flat().join('')).toContain('checkpoint failed');
});
