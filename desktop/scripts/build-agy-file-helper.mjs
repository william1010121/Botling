// Development-only provisioning; no global installation or app packaging.
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('macOS arm64 required');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'.cache/agy-acp-dev/server/botling-agy-file-helper');
mkdirSync(dirname(output),{recursive:true});
execFileSync('/usr/bin/clang',['-std=c11','-D_DARWIN_C_SOURCE','-O2','-Wall','-Wextra','-Werror',resolve(root,'src/core/agent/agy-file-helper.c'),'-o',output],{stdio:'inherit'});
console.log(JSON.stringify({output,sha256:createHash('sha256').update(readFileSync(output)).digest('hex')}));
