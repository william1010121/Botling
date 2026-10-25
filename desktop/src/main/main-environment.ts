import {join} from 'node:path';
/** Empty standard directory overrides are not meaningful directories. Import/1.x defaults use the
 * launch HOME, so a synthetic launch cannot accidentally discover the login user's real folders. */
export function directoryDefaults(env:Record<string,string>,home:string,packaged:boolean):void{
 for(const key of ['CODEX_HOME','CLAUDE_CONFIG_DIR','TMPDIR'])if(env[key]==='')delete env[key];
 if(packaged){if(!env.BOTLING_IMPORT_FROM)env.BOTLING_IMPORT_FROM=join(home,'.claudecodebot');if(!env.BOTLING_1X_DIR)env.BOTLING_1X_DIR=join(home,'.claudecodebot');}
}
