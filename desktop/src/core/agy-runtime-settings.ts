import { accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyAcpRuntime } from './agent/agy-acp';
import { verifyAgyFileHelper } from './agent/agy-mcp';
import type { RawSettings } from './settings';

const location = 'Settings → Engines and subagents → Antigravity';
export function agyRuntimeChoice(raw: RawSettings, env: NodeJS.ProcessEnv = process.env) {
  const saved = typeof raw.agyAcpPath === 'string' ? raw.agyAcpPath.trim() || null : null;
  // Preserve the explicit nonempty environment override, including invalid values: never silently fall back.
  const override = env.BOTLING_AGY_ACP_PATH || null;
  return { saved, override, effective: override ?? saved };
}

/** Only inspect pinned bytes/signatures/access. Never execute a runtime or perform OAuth. */
export function validateAgyRuntimePath(command: string, workspace: string) {
  try {
    verifyAcpRuntime(command);
    accessSync(command, constants.X_OK);
    accessSync(join(dirname(command), 'localharness_external'), constants.X_OK);
    const helper = join(dirname(command), 'botling-agy-file-helper');
    verifyAgyFileHelper(helper, workspace);
    accessSync(helper, constants.X_OK);
  } catch (error) {
    throw new Error(`Antigravity runtime validation failed: ${(error as Error).message}. Open ${location} and select the official macOS arm64 ACP 1.4.3 agy_acp_server.par with localharness_external and the verified Botling file helper in the same folder, outside the project. Legacy CLI remains disabled.`);
  }
}

export function resolveAgyRuntime(raw: RawSettings, workspace: string, env: NodeJS.ProcessEnv = process.env) {
  const { effective, override } = agyRuntimeChoice(raw, env);
  if (!effective) throw new Error(`Antigravity runtime is not configured. Open Settings → Doctor to install locally, or ${location} to save the official ACP 1.4.3 runtime path. Legacy CLI remains disabled.`);
  try { validateAgyRuntimePath(effective, workspace); }
  catch (error) { throw new Error(`${(error as Error).message}${override ? ' BOTLING_AGY_ACP_PATH overrides the saved setting; correct or remove that environment variable and restart the app.' : ''}`); }
  return effective;
}

export function agyRuntimeStatus(raw: RawSettings, workspace: string) {
  const choice = agyRuntimeChoice(raw);
  if (process.platform !== "darwin" || process.arch !== "arm64") return { ...choice, valid: false, message: "Antigravity ACP 1.4.3 requires macOS arm64. Automatic local installation is unavailable on this host." };
  try {
    resolveAgyRuntime(raw, workspace);
    return { ...choice, valid: true, message: 'Official ACP 1.4.3 runtime and Botling helper verified. Project location is checked again at launch; Google sign-in and connection have not been tested.' };
  } catch (error) { return { ...choice, valid: false, message: (error as Error).message }; }
}
