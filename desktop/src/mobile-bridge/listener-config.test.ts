import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:https';
import { startBridge, type BridgeOptions } from './bridge';
import { listenWithHandover } from './lifecycle';
vi.mock('node:https', () => ({ createServer: vi.fn(() => ({})) }));
vi.mock('./lifecycle', () => ({ listenWithHandover: vi.fn(() => ({ close: vi.fn() })) }));
const options = (): BridgeOptions => ({ origin: 'https://botling-bridge.driseam.com', host: '127.0.0.1', port: 8443,
  tls: { key: 'fixture', cert: 'fixture' }, assets: '/unused', clients: () => [],
  ledger: {} as BridgeOptions['ledger'], core: { mobileCommand: vi.fn() } });
beforeEach(() => vi.clearAllMocks());
describe('public origin and independent private listener', () => {
  it('uses public443/private8443 and preserves TLS minimum without opening a socket', () => {
    startBridge(options(), vi.fn());
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({ minVersion: 'TLSv1.2' }), expect.any(Function));
    expect(listenWithHandover).toHaveBeenCalledWith(expect.anything(), 8443, '127.0.0.1', expect.any(Function));
  });
  it.each([0, -1, 65536, 1.5, NaN])('rejects invalid private listener port %s', port => {
    expect(() => startBridge({ ...options(), port }, vi.fn())).toThrow(); expect(createServer).not.toHaveBeenCalled();
  });
  it.each(['0.0.0.0', '8.8.8.8', '127.0.0.999', 'localhost'])('rejects wildcard/public/non-IP bind %s', host => {
    expect(() => startBridge({ ...options(), host }, vi.fn())).toThrow(); expect(createServer).not.toHaveBeenCalled();
  });
  it.each(['http://botling-bridge.driseam.com', 'https://botling-bridge.driseam.com/path', 'https://user:secret@botling-bridge.driseam.com'])('rejects non-origin HTTPS value %s', origin => {
    expect(() => startBridge({ ...options(), origin }, vi.fn())).toThrow(); expect(createServer).not.toHaveBeenCalled();
  });
});
