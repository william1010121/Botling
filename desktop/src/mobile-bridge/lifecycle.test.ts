import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Server } from 'node:https';
import { closeWithCore, listenWithHandover } from './lifecycle';
import { startConfiguredMobile } from './start';

class Listener extends EventEmitter {
  listening = false;
  signal?: AbortSignal;
  listen = vi.fn((options: { signal: AbortSignal }) => { this.signal = options.signal; return this; });
  close = vi.fn(() => { this.listening = false; return this; });
  closeAllConnections = vi.fn();
  occupied() { this.emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' })); }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const setup = () => {
  vi.useFakeTimers();
  const server = new Listener(), failed = vi.fn();
  const mobile = listenWithHandover(server as unknown as Server, 8443, '127.0.0.1', failed);
  return { server, failed, mobile };
};
describe('mobile bridge lifecycle', () => {
  it('skips probe before configuration IO or listener creation', () => {
    vi.useFakeTimers();
    const listen = vi.spyOn(Server.prototype, 'listen');
    vi.stubEnv('BOTLING_CORE_PROBE', '1');
    vi.stubEnv('BOTLING_MOBILE_CONFIG', '/nonexistent/probe-must-not-read.json');
    const core = { mobileCommand: vi.fn(), shutdown: vi.fn(async () => {}) };
    const originalShutdown = core.shutdown;
    expect(startConfiguredMobile(core, '/nonexistent/probe-must-not-write', vi.fn())).toBeNull();
    expect(core.shutdown).toBe(originalShutdown);
    expect(listen).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('recovers transient port ownership with one server and stops retrying after listening', () => {
    const { server, failed, mobile } = setup();
    server.occupied();
    vi.advanceTimersByTime(249); expect(server.listen).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); expect(server.listen).toHaveBeenCalledTimes(2);
    server.listening = true; server.emit('listening');
    vi.runAllTimers();
    expect(server.listen).toHaveBeenCalledTimes(2); expect(failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); mobile.close();
  });
  it('core shutdown cancels pending retries before core teardown', async () => {
    const { server, mobile } = setup();
    server.occupied();
    const shutdown = vi.fn(async () => { expect(server.signal?.aborted).toBe(true); });
    const core = { shutdown };
    closeWithCore(core, mobile);
    await core.shutdown(); await core.shutdown();
    vi.runAllTimers();
    expect(server.listen).toHaveBeenCalledTimes(1); expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels in-flight listen and closes an established listener on shutdown', () => {
    const pending = setup(); pending.mobile.close();
    expect(pending.server.signal?.aborted).toBe(true);
    pending.server.emit('listening'); expect(pending.server.close).toHaveBeenCalled();
    const active = setup(); active.server.listening = true; active.server.emit('listening'); active.mobile.close();
    expect(active.server.listening).toBe(false); expect(active.server.closeAllConnections).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds permanent port failure to eight attempts with no remaining timers', () => {
    const { server, failed } = setup();
    for (let attempt = 0; attempt < 8; attempt++) { server.occupied(); vi.runAllTimers(); }
    expect(server.listen).toHaveBeenCalledTimes(8); expect(failed).toHaveBeenCalledOnce();
    expect(server.signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    server.occupied(); vi.runAllTimers(); expect(failed).toHaveBeenCalledOnce();
  });
  it('does not retry non-handover errors or invalid configuration', () => {
    const { server, failed } = setup();
    server.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' }));
    vi.runAllTimers(); expect(server.listen).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
    vi.stubEnv('BOTLING_CORE_PROBE', '0');
    vi.stubEnv('BOTLING_MOBILE_CONFIG', '/nonexistent/invalid-mobile.json');
    expect(() => startConfiguredMobile({ mobileCommand: vi.fn(), shutdown: vi.fn() }, '/unused', vi.fn())).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
