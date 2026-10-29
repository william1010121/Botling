import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnvironment } from './runner';
import { resolveExecutable } from '../process/executable';
import { processTreeAdapter } from '../process/tree';
import { ACP_VERSION } from './agy-acp';
import type { ModelDiscovery, ModelEngine, DiscoveredModel } from '../../contract/model-discovery';

type Obj = Record<string, any>;
export const MODEL_SOURCES = { claude: 'Claude Code initialization', codex: 'Codex app-server model/list', agy: 'Antigravity ACP session/new' };
export const discoveryFailure = (engine: ModelEngine, status: ModelDiscovery['status'], message: string): ModelDiscovery => ({ status, models: [], source: MODEL_SOURCES[engine], message });
const validId = (id: unknown): id is string => typeof id === 'string' && id.length <= 200 && /^[A-Za-z0-9_.:/-]+$/.test(id);
export function normalizeModels(engine: ModelEngine, values: unknown, defaultId?: string): DiscoveredModel[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values.flatMap((m: any): DiscoveredModel[] => {
    if (!m || m.hidden === true) return [];
    const id = engine === 'claude' ? m.value : engine === 'agy' ? m.modelId : (m.model ?? m.id);
    if (!validId(id) || seen.has(id)) return [];
    seen.add(id);
    const effort = engine === 'claude' ? m.supportedEffortLevels : engine === 'codex' ? (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((e: any) => e?.reasoningEffort) : null) : null;
    return [{ id, name: String(m.displayName ?? m.name ?? id).slice(0, 200), isDefault: m.isDefault === true || id === defaultId || (engine === 'claude' && id === 'default'), efforts: Array.isArray(effort) ? effort.filter((e: unknown): e is string => typeof e === 'string').slice(0, 10) : null }];
  }).slice(0, 200);
}
export interface DiscoveryCommand { file: string; prefixArgs?: string[]; env?: Record<string, string | undefined>; cwd?: string }
/** No user/turn/prompt/authenticate requests. Close the process tree even on timeout or malformed output. */
export async function discoverModels(engine: ModelEngine, command: DiscoveryCommand, timeoutMs = 20_000): Promise<ModelDiscovery> {
  const scratch = mkdtempSync(join(tmpdir(), 'botling-models-'));
  try {
    const env = childEnvironment(command.env);
    if (engine === 'claude') {
      const signedOut = await new Promise<boolean>(resolve => {
        execFile(resolveExecutable(command.file, env), [...(command.prefixArgs ?? []), 'auth', 'status', '--json'],
          { env, cwd: command.cwd ?? scratch, timeout: Math.min(timeoutMs, 5_000), maxBuffer: 64 * 1024 }, (_error, stdout) => {
            try { resolve(JSON.parse(stdout).loggedIn === false); } catch { resolve(false); }
          });
      });
      if (signedOut) return discoveryFailure(engine, 'signed-out', 'Claude requires sign-in. Sign in through Claude, then retry.');
    }
    let args: string[];
    if (engine === 'claude') args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--tools', '', '--settings', '{"disableAllHooks":true}'];
    else if (engine === 'codex') args = ['app-server'];
    else {
      args = [];
      // A disposable profile: never alter a bot conversation or global hooks/trust settings.
      const home = join(scratch, 'profile');
      mkdirSync(join(home, 'antigravity-acp'), { recursive: true, mode: 0o700 });
      mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, 'antigravity-acp/settings.json'), '{"auth":{"type":"oauth-personal"}}', { mode: 0o600 });
      writeFileSync(join(home, 'config/hooks.json'), '{}');
      writeFileSync(join(home, 'config/mcp_config.json'), '{}');
      // Match ACP's existing runtime auth environment. Never send an authenticate request.
      for (const key of Object.keys(env)) if (!['HOME','USER','PATH','TMPDIR','LANG'].includes(key)) delete env[key];
      env.GEMINI_HOME = home;
    }
    const proc = processTreeAdapter().spawn(resolveExecutable(command.file, env), [...(command.prefixArgs ?? []), ...args], { env, cwd: engine === 'agy' ? scratch : command.cwd ?? scratch });
    const child = proc.child;
    try {
      return await new Promise<ModelDiscovery>((resolve) => {
        let done = false, buffer = '', page = 0;
        const models: DiscoveredModel[] = [];
        const cursors = new Set<string>();
        const finish = (result: ModelDiscovery) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
        const fail = (status: ModelDiscovery['status'], message: string) => finish(discoveryFailure(engine, status, message));
        const timer = setTimeout(() => fail('error', 'Model discovery timed out. Retry when the engine is available.'), timeoutMs);
        const send = (value: Obj) => { if (!done && child.stdin.writable) child.stdin.write(JSON.stringify(value) + '\n'); };
        const rpc = (id: number, method: string, params: Obj) => send({ jsonrpc: '2.0', id, method, params });
        const ready = (values: DiscoveredModel[]) => finish({ status: 'ready', models: values, source: MODEL_SOURCES[engine], message: engine === 'agy' ? 'Models advertised by ACP. Access is checked when a task runs.' : 'Runtime catalog; account access is not guaranteed. No generation was requested.' });
        child.stdin.on('error', () => {});
        child.stderr.resume(); // Provider diagnostics may contain auth URLs or secrets.
        child.once('error', (error: NodeJS.ErrnoException) => fail(error.code === 'ENOENT' ? 'unavailable' : 'error', 'Cannot start the configured engine. Check its installation and retry.'));
        child.once('close', () => fail('error', 'The engine closed before returning models. Check sign-in and retry.'));
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          if (done) return;
          buffer += chunk;
          if (buffer.length > 2 * 1024 * 1024) { fail('error', 'Model discovery response exceeded its limit.'); return; }
          let at: number;
          while (!done && (at = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
            let m: Obj; try { m = JSON.parse(line); } catch { continue; }
            if (!m || typeof m !== 'object') continue;
            if (engine === 'claude') {
              if (m.type !== 'control_response' || m.response?.request_id !== 'models') continue;
              const r = m.response;
              if (r.subtype !== 'success') { fail('unsupported', 'This Claude runtime did not provide a model catalog. Keep the default or saved choice.'); continue; }
              if (!Array.isArray(r.response?.models)) { fail('unsupported', 'This Claude runtime does not report supported models.'); continue; }
              ready(normalizeModels(engine, r.response.models));
              continue;
            }
            if (m.error) {
              const code = m.error.code;
              fail(code === -32000 && engine === 'agy' ? 'signed-out' : code === -32601 ? 'unsupported' : 'error', code === -32000 && engine === 'agy' ? 'ACP requires sign-in. Sign in through the engine, then retry.' : 'The engine rejected model discovery. Check sign-in and runtime support, then retry.');
              continue;
            }
            if (m.method && m.id !== undefined) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Discovery client has no action capabilities.' } }); continue; }
            if (m.id === 1) {
              if (engine === 'codex') { send({ jsonrpc: '2.0', method: 'initialized' }); rpc(2, 'account/read', { refreshToken: false }); }
              else if (m.result?.protocolVersion === 1 && m.result?.agentInfo?.name === 'antigravity-acp' && m.result?.agentInfo?.version === ACP_VERSION) rpc(3, 'session/new', { cwd: scratch, mcpServers: [], _meta: { antigravity: { enabledTools: [] } } });
              else fail('unsupported', 'The ACP runtime did not confirm its supported version.');
            } else if (engine === 'codex' && m.id === 2) {
              if (!m.result?.account && m.result?.requiresOpenaiAuth === true) fail('signed-out', 'Codex requires sign-in. Sign in through Codex, then retry.');
              else rpc(3, 'model/list', { limit: 100, includeHidden: false });
            } else if (m.id === 3) {
              const values = engine === 'codex' ? m.result?.data : m.result?.models?.availableModels;
              if (!Array.isArray(values)) { fail('unsupported', 'This runtime does not expose a model list. Keep the default or saved choice.'); continue; }
              models.push(...normalizeModels(engine, values, m.result?.models?.currentModelId));
              const cursor = engine === 'codex' ? m.result?.nextCursor : null;
              if (cursor) {
                if (typeof cursor !== 'string' || cursors.has(cursor) || ++page > 10) { fail('error', 'The model catalog returned invalid pagination.'); continue; }
                cursors.add(cursor); rpc(3, 'model/list', { limit: 100, includeHidden: false, cursor });
              } else ready([...new Map(models.map(m => [m.id, m])).values()].slice(0, 200));
            }
          }
        });
        if (engine === 'claude') send({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } });
        else rpc(1, 'initialize', engine === 'codex' ? { clientInfo: { name: 'botling_models', version: '2' } } : { protocolVersion: 1, clientInfo: { name: 'Botling', version: '2' }, clientCapabilities: {} });
      });
    } finally { await proc.terminate({ graceMs: 200 }); }
  } catch { return discoveryFailure(engine, 'unavailable', 'The configured engine could not be queried. Check the runtime and retry.'); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
/** Only in-flight requests are shared. Refresh always queries the runtime again. */
export function modelDiscoveryService(query: (engine: ModelEngine, botId: string) => Promise<ModelDiscovery>) {
  const pending = new Map<string, Promise<ModelDiscovery>>();
  return (engine: ModelEngine, botId: string) => {
    const key = `${engine}:${botId}`;
    let result = pending.get(key);
    if (!result) { result = query(engine, botId).finally(() => pending.delete(key)); pending.set(key, result); }
    return result;
  };
}
