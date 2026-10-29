import {expect,it} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CoreHarness} from '../core-harness';
import {tempDir,until} from '../helpers';
import {fileReference} from '../../../Web/src/file-preview';
it('carries a selected project reference through chat.send to the model without file contents',async()=>{
 const dir=tempDir('file-reference');const folder=join(dir,'project');mkdirSync(folder);
 const botId='44444444-4444-4444-8444-444444444444';
 writeFileSync(join(dir,'projects.json'),JSON.stringify([{id:botId,name:'Files',folder:pathToFileURL(folder).href+'/',avatar:'hexagon'}]));
 writeFileSync(join(folder,'a b.ts'),'NEVER_AUTO_EMBED_THIS_CONTENT');
 const input=join(dir,'input.log');const core=new CoreHarness(dir,{FAKE_CLAUDE_INPUT:input});
 try{
  await core.call({type:"boot.commit"});
  const result=await core.call({type:'project.files',botId,query:'abt'});
  expect(result.files).toHaveLength(1);
  const preview=await core.call({type:'project.preview',botId,path:result.files[0].path});expect(preview.text).toBe('NEVER_AUTO_EMBED_THIS_CONTENT');
  await expect(core.call({type:'project.preview',botId,path:'../projects.json'})).rejects.toThrow();
  const text=`Review ${fileReference(result.files[0].path,result.files[0].url)}`;
  await core.call({type:'chat.send',botId,text});
  const delivered=await until(()=>existsSync(input)&&readFileSync(input,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line).text).find((line:string)=>line.includes('Review ')));
  expect(delivered).toContain(result.files[0].url);expect(delivered).not.toContain('NEVER_AUTO_EMBED_THIS_CONTENT');
  expect((await core.chat(botId)).messages.some((message:{role:string;text:string})=>message.role==='user'&&message.text===text.trim())).toBe(true);
 }finally{await core.kill();}
});
