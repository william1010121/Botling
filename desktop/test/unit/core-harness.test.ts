// Failure diagnostics must preserve the cause rather than replacing it with a ten-second timeout.
import {expect,it} from 'vitest';
import {once} from 'node:events';
import {CoreHarness} from '../core-harness';
import {tempDir} from '../helpers';
it('reports an exited core immediately, including signal, pending command and captured stderr',async()=>{
 const c=new CoreHarness(tempDir('harness-exit'));
 try{
  await c.call({type:'settings.get'});c.stderr+='\nsynthetic root failure: resource pressure';
  const exited=once(c.child,'exit');c.child.kill('SIGKILL');await exited;
  const start=Date.now();await expect(c.call({type:'settings.get'},{timeout:500})).rejects.toThrow(/SIGKILL[\s\S]*settings.get[\s\S]*synthetic root failure/);
  expect(Date.now()-start).toBeLessThan(450);
 }finally{if(c.child.exitCode===null&&c.child.signalCode===null)await c.kill();}
});
it('cleanup joins an already exited child without waiting for a lost exit event',async()=>{
 const c=new CoreHarness(tempDir('harness-join'));
 await c.call({type:'settings.get'});const exited=once(c.child,'exit');c.child.kill('SIGTERM');await exited;
 const done=c.kill();expect(await Promise.race([done.then(()=>true),new Promise(r=>setTimeout(()=>r(false),250))])).toBe(true);
});
