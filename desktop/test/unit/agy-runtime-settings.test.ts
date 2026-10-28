import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsChange, Command, RENDERER_COMMANDS } from '../../src/contract';
import { applySetting, readSettings, settingsView, writeSettings } from '../../src/core/settings';
import { agyRuntimeChoice, resolveAgyRuntime, agyRuntimeStatus, validateAgyRuntimePath } from '../../src/core/agy-runtime-settings';
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'agy-settings-')); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach(dir => rmSync(dir, {recursive:true,force:true})); });
it('persists a trimmed path across reads and clears only its own key', () => {
 const file = join(temp(), 'settings.json'), raw = { future: { keep: true }, languageChoice: 'ja' };
 writeSettings(file, applySetting(raw, {key:'agyAcpPath',value:' /official/agy_acp_server.par '}));
 expect(settingsView(readSettings(file)).agyAcpPath).toBe('/official/agy_acp_server.par');
 writeSettings(file, applySetting(readSettings(file), {key:'agyAcpPath',value:' '}));
 expect(readSettings(file)).toEqual(raw);
 expect(settingsView({agyAcpPath:42}).agyAcpPath).toBeNull();
});
it('keeps explicit environment precedence without fallback on an invalid override', () => {
 expect(agyRuntimeChoice({agyAcpPath:'/saved'}, {})).toEqual({saved:'/saved',override:null,effective:'/saved'});
 expect(agyRuntimeChoice({agyAcpPath:'/saved'}, {BOTLING_AGY_ACP_PATH:''}).effective).toBe('/saved');
 expect(agyRuntimeChoice({agyAcpPath:'/saved'}, {BOTLING_AGY_ACP_PATH:'relative'}).effective).toBe('relative');
 expect(() => resolveAgyRuntime({agyAcpPath:'/saved'}, temp(), {BOTLING_AGY_ACP_PATH:'relative'})).toThrow('overrides the saved setting');
});
it('returns actionable missing, nonexistent, relative and tampered runtime errors without launching', () => {
 vi.stubEnv('BOTLING_AGY_ACP_PATH','');
 expect(agyRuntimeStatus({}, temp())).toMatchObject({valid:false,effective:null,message:expect.stringContaining('Settings → Engines and subagents → Antigravity')});
 expect(() => resolveAgyRuntime({}, temp(), {})).toThrow('not configured');
 const dir = temp(), fake = join(dir,'agy_acp_server.par'); writeFileSync(fake,'not an executable');
 for (const path of ['agy',join(dir,'absent'),fake]) expect(() => validateAgyRuntimePath(path,dir)).toThrow('Legacy CLI remains disabled');
 expect(agyRuntimeStatus({agyAcpPath:fake}, dir).valid).toBe(false);
});
it('exposes bounded Settings input and renderer read-only validation command', () => {
 expect(SettingsChange.parse({key:'agyAcpPath',value:null}).key).toBe('agyAcpPath');
 for (const value of [42,'a'.repeat(4097)]) expect(SettingsChange.safeParse({key:'agyAcpPath',value}).success).toBe(false);
 expect(Command.safeParse({type:'agy.runtime.check'}).success).toBe(true);
 expect(RENDERER_COMMANDS.has('agy.runtime.check')).toBe(true);
});
// Optional local verification is read-only: no runtime process, login, or model request.
it.skipIf(!process.env.BOTLING_TEST_OFFICIAL_ACP)('verifies provisioned official bytes/signatures/helper and rejects placement inside the workspace', () => {
 const path = process.env.BOTLING_TEST_OFFICIAL_ACP!;
 expect(resolveAgyRuntime({agyAcpPath:path}, temp(), {})).toBe(path);
 expect(() => resolveAgyRuntime({agyAcpPath:path}, '/', {})).toThrow('outside the agent workspace');
});
