import {join} from 'node:path';
/** Empty standard directory overrides are not meaningful directories. Import/1.x defaults use the
 * launch HOME, so a synthetic launch cannot accidentally discover the login user's real folders.
 * A packaged app (the dev trial too) imports 1.x (~/.claudecodebot) by default, as the
 * normal app does; `BOTLING_IMPORT_FROM` pointing at another folder imports that one instead. */
export function directoryDefaults(env:Record<string,string>,home:string,packaged:boolean,_devTrial=false):void{
 for(const key of ['CODEX_HOME','CLAUDE_CONFIG_DIR','TMPDIR'])if(env[key]==='')delete env[key];
 if(packaged){if(!env.BOTLING_IMPORT_FROM)env.BOTLING_IMPORT_FROM=join(home,'.claudecodebot');if(!env.BOTLING_1X_DIR)env.BOTLING_1X_DIR=join(home,'.claudecodebot');}
}

/** Trial data never shares the normal packaged profile. Explicit data overrides still work. */
export function packagedDataName(devTrial:boolean):string{return devTrial?"Botling 2 Dev Trial":"Botling 2";}
