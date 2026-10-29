import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectFiles, fuzzyScore } from '../../src/core/project-files';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(root => rm(root, {recursive:true,force:true}))); });
it('ranks contiguous filename matches above scattered paths', () => {
 expect(fuzzyScore('src/composer.ts','comp')).toBeGreaterThan(fuzzyScore('common/map.ts','comp'));
 expect(fuzzyScore('src/other.ts','xyz')).toBe(-1);
});
it('searches scoped files, honors ignore rules, rejects escapes, and bounds previews', async () => {
 const root = await mkdtemp(join(tmpdir(),'mention-')); roots.push(root);
 await mkdir(join(root,'src')); await mkdir(join(root,'node_modules'));
 await writeFile(join(root,'.gitignore'),'secret.txt\n');
 await writeFile(join(root,'secret.txt'),'secret'); await writeFile(join(root,'.env'),'private');
 await writeFile(join(root,'node_modules','dep.js'),'dependency');
 await writeFile(join(root,'src','composer.ts'),'const value = "<script>";');
 await writeFile(join(root,'large.txt'),'a'.repeat(100000)); await writeFile(join(root,'binary.bin'),Buffer.from([0,1,2]));
 await symlink('/etc/passwd',join(root,'escape.txt'));
 const files = new ProjectFiles(); const result = await files.search(root,'');
 expect(result.files.map(f=>f.path).sort()).toEqual(['binary.bin','large.txt','src/composer.ts']);
 expect((await files.preview(root,'src/composer.ts')).text).toContain('<script>');
 expect((await files.preview(root,'large.txt')).status).toBe('truncated');
 expect((await files.preview(root,'binary.bin')).status).toBe('binary');
 await expect(files.preview(root,'../passwd')).rejects.toThrow();
 await expect(files.preview(root,'escape.txt')).rejects.toThrow();
 await expect(files.preview(root,'secret.txt')).rejects.toThrow();
});
it('honors nested git ignores and excludes tracked private/ignored files', async()=> {
 const {execFileSync}=await import('node:child_process');
 const root=await mkdtemp(join(tmpdir(),'mention-git-'));roots.push(root);
 execFileSync('git',['init','-q',root]);await mkdir(join(root,'src'));
 await writeFile(join(root,'src','.gitignore'),'*.secret\n');
 await writeFile(join(root,'src','hidden.secret'),'private');await writeFile(join(root,'src','safe.ts'),'ok');
 execFileSync('git',['-C',root,'add','-f','src/hidden.secret']);
 const files=new ProjectFiles();const result=await files.search(root,'');
 expect(result.files.some(file=>file.path==='src/safe.ts')).toBe(true);
 expect(result.files.some(file=>file.path==='src/hidden.secret')).toBe(false);
 await expect(files.preview(root,'src/hidden.secret')).rejects.toThrow();
});
it('accepts bounded native editor responses and rejects malformed payloads', async()=> {
 const {editorMessageAllowed}=await import('../../src/editor-host-wire');
 expect(editorMessageAllowed('down',{botling:'projectFilesResult',requestID:1,value:{files:[{path:'a.ts',url:'file:///project/a.ts'}],limited:false}})).toBe(true);
 expect(editorMessageAllowed('down',{botling:'projectFilesResult',requestID:2,value:{text:'const a=1;',status:'text'}})).toBe(true);
 expect(editorMessageAllowed('down',{botling:'projectFilesResult',requestID:2,value:{text:'a'.repeat(32769),status:'text'}})).toBe(false);
 expect(editorMessageAllowed('down',{botling:'projectFilesResult',requestID:2,value:{files:[{path:'a',url:'https://remote'}],limited:false}})).toBe(false);
});
