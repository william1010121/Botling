import {expect,it,vi} from 'vitest';
import * as frontmost from '../frontmost';
it('F0 -600 is a missing automation target, never permission granted or a frontmost proof',()=>{
 expect(typeof (frontmost as any).parseFrontmostResult).toBe('function');
 expect(()=>(frontmost as any).parseFrontmostResult({code:0,stdout:'-600\n',stderr:''})).toThrow(/procNotFound.*not.*permission/i);
});
it('F0 a missing frontmost application fails closed without trying a GUI/automation fallback',async()=>{
 const read=vi.fn(async()=>({code:0,stdout:'{"pid":null,"bundleId":null,"active":false}',stderr:''}));
 expect(typeof (frontmost as any).readFrontmost).toBe('function');
 await expect((frontmost as any).readFrontmost(read)).rejects.toThrow(/frontmost.*unavailable/i);expect(read).toHaveBeenCalledTimes(1);
});
it.each([{code:3,stdout:'',stderr:'frontmost metadata unavailable'},{code:0,stdout:'',stderr:''},{code:0,stdout:'{"pid":12,"bundleId":"org.synthetic","active":false}',stderr:''}])('F0 incomplete native metadata or tool failure is not a proof: %j',result=>{
 expect(typeof (frontmost as any).parseFrontmostResult).toBe('function');expect(()=>(frontmost as any).parseFrontmostResult(result)).toThrow();
});
it('F0 read-only metadata returns only a positive PID and exact bundle identity',async()=>{
 expect(typeof (frontmost as any).readFrontmost).toBe('function');await expect((frontmost as any).readFrontmost(async()=>({code:0,stdout:'{"pid":42,"bundleId":"org.synthetic.frontmost","active":true}',stderr:''}))).resolves.toBe('42\torg.synthetic.frontmost');
});
