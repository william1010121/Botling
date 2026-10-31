import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import ts from 'typescript';
import {scrubEnvironment} from '../../src/main/packaged';
import {desktop} from '../helpers';
it('F0 packaged binaries preserve the operational hidden flag',()=>{const env:Record<string,string>={BOTLING_HIDDEN:'1'};scrubEnvironment(env,true);expect(env.BOTLING_HIDDEN).toBe('1');});
it('F0 every production BrowserWindow is constructed without showing',()=>{const failures:number[]=[];let count=0;for(const file of ['src/main/main.ts']){const text=readFileSync(join(desktop,file),'utf8'),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);const visit=(node:ts.Node)=>{if(ts.isNewExpression(node)&&node.expression.getText(ast)==='BrowserWindow'){count++;const option=node.arguments?.[0];const show=option&&ts.isObjectLiteralExpression(option)?option.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(ast)==='show'):null;if(!show||!ts.isPropertyAssignment(show)||show.initializer.kind!==ts.SyntaxKind.FalseKeyword)failures.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1);}ts.forEachChild(node,visit);};visit(ast);}expect(count).toBeGreaterThanOrEqual(3);expect(failures).toEqual([]);});
it('F0 hidden activation policy is installed before readiness and native windows',()=>{const source=readFileSync(join(desktop,'src/main/main.ts'),'utf8');expect(source).toMatch(/configureHiddenApp\(app\)/);expect(source.indexOf('configureHiddenApp(app)')).toBeLessThan(source.indexOf('app.whenReady()'));});
it('F0 all packaged tests are gated before any fixture can launch a binary',()=>{const source=readFileSync(join(desktop,'playwright.packaged.config.ts'),'utf8');expect(source).toContain('BOTLING_TEST_ALLOW_FOCUS');expect(source).toContain('testIgnore');});

it('F0 activation policy is prohibited before ready, never a late activation toggle',async()=>{const {configureHiddenApp}=await import('../../src/main/hidden-mode');const calls:string[]=[];configureHiddenApp({isReady:()=>false,setActivationPolicy:p=>calls.push(p)},'darwin',true);expect(calls).toEqual(['prohibited']);expect(()=>configureHiddenApp({isReady:()=>true,setActivationPolicy:()=>{}},'darwin',true)).toThrow(/before ready/);});
it('F0 foreground helper env is denied unless explicitly opted in',async()=>{const {requireFocusOptIn}=await import('../hidden');expect(()=>requireFocusOptIn({BOTLING_HIDDEN:'0'})).toThrow(/authorization/);expect(()=>requireFocusOptIn({BOTLING_HIDDEN:'1'})).not.toThrow();});
