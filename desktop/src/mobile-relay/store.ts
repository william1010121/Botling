// What the desktop keeps for the relay, in the profile's owner-only `mobile/` folder (beside the bridge's files):
//   relay.json          the relay address, this desktop's room key (proves to the relay that it owns its room) and its
//                       X25519 identity key (the phone pins its public half from the QR code)
//   relay-devices.json  paired phones: their static public key, the hash of their relay access token, their bots, expiry
// Nothing here is a chat. Written atomically under a file lock; nothing is logged.
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { withFileLock, writeFileAtomic } from '../core/durable/atomic';
import { b64u, exportPrivateKey, generateKeyPair, importKeyPair, type KeyPair } from './e2e';

export const PAIRED_TTL_MS = 30 * 86_400_000;
const B64U = /^[A-Za-z0-9_-]+$/;
const Settings = z.strictObject({
  url: z.string().max(300).nullable(),
  roomKey: z.string().length(43).regex(B64U),
  privateKey: z.string().max(200).regex(B64U),
  publicKey: z.string().length(43).regex(B64U),
});
type Settings = z.infer<typeof Settings>;
export const RelayDevice = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  publicKey: z.string().length(43).regex(B64U),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  botIds: z.array(z.string().min(1).max(64)).min(1).max(200),
  pairedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  label: z.string().max(40).optional(),
});
export type RelayDevice = z.infer<typeof RelayDevice>;

/** A relay address the desktop may connect to: wss:// anywhere, ws:// only to this machine (development). */
export function relayURL(input: string): string {
  const url = new URL(input.trim());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'wss:' || (url.protocol === 'ws:' && local)) || url.username || url.password || url.search || url.hash)
    throw new Error('Use a wss:// relay address (ws:// only for localhost), without credentials, query or fragment.');
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  if (url.pathname !== '/ws') throw new Error('The relay address ends in /ws.');
  return url.href;
}
/** The page a phone opens for this relay: same host, http(s) instead of ws(s), the web app under /mobile/. */
export const relayPage = (url: string) => { const u = new URL(url); return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}/mobile/`; };

export class RelayStore {
  private identity: Promise<KeyPair> | null = null;
  constructor(private dir: string, private now: () => number = Date.now) {}
  private file(name: string) { return join(this.dir, name); }
  private ensureDir() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.dir);
    if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('The phone folder must be owner-only.');
  }
  private readJSON(name: string): unknown {
    const file = this.file(name);
    if (!existsSync(file)) return undefined;
    const stat = statSync(file);
    if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Phone files must be owner-only.');
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  private write(name: string, value: unknown) { writeFileAtomic(this.file(name), JSON.stringify(value)); }

  settings(): Settings | null {
    const raw = this.readJSON('relay.json');
    return raw === undefined ? null : Settings.parse(raw);
  }
  /** The relay address, or null when the relay is off. */
  url(): string | null { try { return this.settings()?.url ?? null; } catch { return null; } }

  /** Turns the relay on (an address) or off (null). The first time, makes the room key and identity key. */
  async setURL(url: string | null): Promise<void> {
    const clean = url === null ? null : relayURL(url);
    this.ensureDir();
    const existing = this.settings();
    if (existing) { withFileLock(this.file('relay.json'), () => this.write('relay.json', { ...existing, url: clean })); return; }
    const pair = await generateKeyPair(true);
    const made: Settings = { url: clean, roomKey: randomBytes(32).toString('base64url'),
      privateKey: b64u.encode(await exportPrivateKey(pair)), publicKey: b64u.encode(pair.publicKey) };
    withFileLock(this.file('relay.json'), () => { if (!existsSync(this.file('relay.json'))) this.write('relay.json', made); });
    if (this.settings()!.publicKey !== made.publicKey) await this.setURL(clean); // another writer won; set the address on theirs
  }
  /** This desktop's identity key (static X25519). */
  keyPair(): Promise<KeyPair> {
    const settings = this.settings();
    if (!settings) throw new Error('The relay is not set up.');
    return this.identity ??= importKeyPair(b64u.decode(settings.privateKey), b64u.decode(settings.publicKey));
  }

  devices(): RelayDevice[] {
    const now = this.now();
    try { return z.array(RelayDevice).parse(this.readJSON('relay-devices.json') ?? []).filter(d => d.expiresAt > now); } catch { return []; }
  }
  device(id: string): RelayDevice | undefined { return this.devices().find(d => d.id === id); }
  /** One record per phone key: pairing the same phone again replaces it. */
  add(device: RelayDevice) {
    this.ensureDir();
    const file = this.file('relay-devices.json');
    withFileLock(file, () => this.write('relay-devices.json', [...this.devices().filter(d => d.id !== device.id), RelayDevice.parse(device)]));
  }
  revoke(id: string): boolean {
    const file = this.file('relay-devices.json');
    if (!existsSync(file)) return false;
    return withFileLock(file, () => {
      const all = this.devices();
      const kept = all.filter(d => d.id !== id);
      if (kept.length === all.length) return false;
      this.write('relay-devices.json', kept);
      return true;
    });
  }
}
