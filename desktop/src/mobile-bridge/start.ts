import { loadMobileGeneration } from './generation';
import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { Clients, privateJSON, startBridge, type MobileCore } from './bridge';
import { MutationLedger } from './ledger';
import { closeWithCore } from './lifecycle';
import { PairingStore, type Route } from './pairing';
import { MobileDesk } from './desk';

const absolute = z.string().refine(isAbsolute);
const Config = z.strictObject({ origin: z.string().url(), host: z.string(), port: z.number().int().min(1).max(65535),
  // `google` was the removed Google sign-in setting: accepted from older config files, ignored.
  google: z.unknown().optional(),
  /** What `origin` is (the first route a phone tries) and the other ways in, in order. Only what the user lists. */
  originKind: z.enum(['lan', 'tailscale', 'tunnel']).optional(),
  routes: z.array(z.strictObject({ kind: z.enum(['lan', 'tailscale', 'tunnel']), origin: z.string().url() })).max(5).optional(),
  certFile: absolute, keyFile: absolute, clientsFile: absolute, assets: absolute });
/** Explicit env wins (including empty = disabled); otherwise use only this core profile's opt-in.
 * Never export a discovered path: an installer may select a different profile at next startup.
 * Journal location stays under core data; changing TLS/config cannot reset deduplication. */
export function startConfiguredMobile(core: MobileCore & { shutdown(): Promise<void> }, dataDir: string, failed: (error: Error) => void, attach?: (desk: MobileDesk) => void) {
  if (process.env.BOTLING_CORE_PROBE === '1') return null;
  let file = process.env.BOTLING_MOBILE_CONFIG;
  if (file === undefined) {
    const directory = join(dataDir, 'mobile');
    file = join(directory, 'config.json');
    let stat;
    try { stat = lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const parent = lstatSync(directory);
    // A default opt-in must be local to this profile, not a link into another profile.
    if (!stat.isFile() || !parent.isDirectory() || (parent.mode & 0o077)
      || (process.getuid && parent.uid !== process.getuid())) throw new Error('Mobile configuration directory must be private and profile-local.');
  }
  if (!file) return null;
  const { google: _removed, originKind, routes: extra = [], ...config } = Config.parse(privateJSON(file));
  // Packaged assets belong to the authenticated app generation, never an arbitrary stale config path.
  const assets = process.env.BOTLING_APP_BUNDLE ? join(process.env.BOTLING_APP_BUNDLE, 'Contents/Resources/mobile') : config.assets;
  const generation = loadMobileGeneration(assets);
  const receipt = join(dataDir, 'mobile-ready.json');
  rmSync(receipt, { force: true });
  // Paired phones live beside the hand-issued clients file; both authenticate the same way.
  const ordered: Route[] = [{ kind: originKind ?? 'tunnel', origin: config.origin }, ...extra]
    .filter((route, i, all) => all.findIndex(other => other.origin === route.origin) === i);
  const pairing = new PairingStore(join(dataDir, 'mobile'), Date.now, ordered);
  const mobile = startBridge({ ...config, assets, generation, pairing, routes: ordered.slice(1),
    ready: () => {
      const temp = `${receipt}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ pid: process.pid, generation: generation.id, assets }), { mode: 0o600 });
      renameSync(temp, receipt);
    },
    tls: { cert: readFileSync(config.certFile), key: readFileSync(config.keyFile) },
    clients: () => {
      const issued = Clients.parse(privateJSON(config.clientsFile));
      const ids = new Set(issued.map(c => c.id)); // a hand-issued id is never shadowed
      return [...issued, ...Clients.parse(pairing.clients()).filter(c => !ids.has(c.id))];
    }, ledger: new MutationLedger(join(dataDir, 'mobile-mutations')), core }, failed);
  attach?.(new MobileDesk(pairing, ordered));
  closeWithCore(core, mobile);
  return mobile;
}
