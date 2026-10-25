import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

// Execute the actual diagnostic helper with the observed Run15 viewport coordinates.
async function activate(nativeReceipt=true,scrollWorks=true){
 const text=readFileSync(join(import.meta.dirname,'../e2e/d3-hidden.spec.ts'),'utf8'),ast=ts.createSourceFile('probe.ts',text,ts.ScriptTarget.Latest,true);let initializer:ts.Expression|undefined;
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='activate')initializer=node.initializer;ts.forEachChild(node,visit);};visit(ast);expect(initializer).toBeDefined();
 let scrolled=false,domActivations=0;const trace:any[]=[],notes:any[]=[],name='Delete recovery copies…';
 const geometry=()=>({rect:{x:530.8515625,y:scrolled?568.765625:677.265625,width:219.4453125,height:43.1953125},point:{x:640.57421875,y:scrolled?590.36328125:698.86328125},viewport:{width:900,height:668},scroll:{x:0,y:scrolled?108.5:0},hit:scrolled?{tag:'A',text:name}:null,targetHit:scrolled});
 const locator={evaluate:vi.fn(async(fn:Function)=>{if(fn.toString().includes('.click()')){domActivations++;return;}return geometry();}),scrollIntoViewIfNeeded:vi.fn(async()=>{scrolled=scrollWorks;}),boundingBox:async()=>geometry().rect};
 const mouse=vi.fn(async(x:number,y:number)=>{expect(x).toBeGreaterThanOrEqual(0);expect(x).toBeLessThan(900);expect(y).toBeGreaterThanOrEqual(0);expect(y).toBeLessThan(668);if(nativeReceipt)trace.push({event:'renderer',label:'recovery',record:{event:'dom.click',data:{trusted:true,action:{text:name}}}});});
 const fakeExpect=Object.assign((value:unknown,message?:string)=>expect(value,message),{poll:(read:()=>boolean)=>({toBe:async(value:boolean)=>{expect(read()).toBe(value);}})});
 const context={expect:fakeExpect,trace,label:'recovery',failure:undefined,guarded:async(p:Promise<unknown>)=>p,note:(event:string,data:unknown)=>notes.push({event,data})};
 const compiled=ts.transpileModule('('+initializer!.getText(ast)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 let result:unknown,error:unknown;try{result=await runInNewContext(compiled,context)(locator,{mouse:{click:mouse}},name,async()=>nativeReceipt);}catch(e){error=e;}
 return{result,error,locator,mouse,notes,domActivations};
}
it('scrolls the demonstrated off-viewport target before exactly one trusted CDP input',async()=>{
 const r=await activate();expect(r.error).toBeUndefined();expect(r.result).toBe('trusted-CDP');expect(r.locator.scrollIntoViewIfNeeded).toHaveBeenCalledTimes(1);expect(r.mouse).toHaveBeenCalledTimes(1);expect(r.mouse).toHaveBeenCalledWith(640.57421875,590.36328125);expect(r.domActivations).toBe(0);expect(r.notes.find(n=>n.event==='delivery.geometry.before').data.geometry.targetHit).toBe(false);
});
it('keeps a missing CDP receipt separate from one explicitly labeled DOM business activation',async()=>{
 const r=await activate(false);expect(r.error).toBeUndefined();expect(r.result).toBe('DOM');expect(r.mouse).toHaveBeenCalledTimes(1);expect(r.domActivations).toBe(1);expect(r.notes).toContainEqual({event:'activation.dom',data:{name:'Delete recovery copies…',trust:'programmatic/untrusted; action-business-logic only'}});
});
it('never sends native or DOM input when the target still fails viewport hit testing',async()=>{
 const r=await activate(true,false);expect(r.error).toBeDefined();expect(r.mouse).not.toHaveBeenCalled();expect(r.domActivations).toBe(0);
});
