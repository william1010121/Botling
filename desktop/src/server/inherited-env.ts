// What botlingd does not take from the environment it inherits (M1 demo bug 4). The 2.x app imports a 1.x data folder
// named by BOTLING_IMPORT_FROM (and the packaged app sets it and BOTLING_1X_DIR to ~/.claudecodebot); a shell or app that
// ran 2.x may still carry them. Botling 3 imports 1.x/2.x data only in M6, by an explicit step: `botlingd start` and the
// Botling 3 window's botlingd never import from them, and say so in the log.

/** The variables that would make the core import another Botling's data. */
export const INHERITED_IMPORT_VARS = ["BOTLING_IMPORT_FROM", "BOTLING_1X_DIR"] as const;

/** Takes the import variables out of `env` (in place, so no child inherits them either); the names it removed. */
export function dropInheritedImport(env: Record<string, string | undefined>): string[] {
  const dropped: string[] = [];
  for (const key of INHERITED_IMPORT_VARS) {
    if (env[key] === undefined) continue;
    if (env[key] !== "") dropped.push(key);
    delete env[key];
  }
  return dropped;
}
