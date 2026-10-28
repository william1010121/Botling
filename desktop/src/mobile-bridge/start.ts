import { loadMobileGeneration } from './generation';
import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { Clients, privateJSON, startBridge, type MobileCore } from './bridge';
import { MutationLedger } from './ledger';
import { GoogleAuth, GoogleConfig, GoogleCredentials } from './google';
import { closeWithCore } from './lifecycle';

const absolute = z.string().refine(isAbsolute);
const Config = z.strictObject({ origin: z.string().url(), host: z.string(), port: z.number().int().min(1).max(65535),
  google: GoogleConfig.extend({ credentialsFile: absolute }).optional(), certFile: absolute, keyFile: absolute, clientsFile: absolute, assets: absolute });
/** Explicit env wins (including empty = disabled); otherwise use only this core profile's opt-in.
 * Never export a discovered path: an installer may select a different profile at next startup.
 * Journal location stays under core data; changing TLS/config cannot reset deduplication. */
export function startConfiguredMobile(core: MobileCore & { shutdown(): Promise<void> }, dataDir: string, failed: (error: Error) => void) {
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
  const config = Config.parse(privateJSON(file));
  // Packaged assets belong to the authenticated app generation, never an arbitrary stale config path.
  const assets = process.env.BOTLING_APP_BUNDLE ? join(process.env.BOTLING_APP_BUNDLE, 'Contents/Resources/mobile') : config.assets;
  const generation = loadMobileGeneration(assets);
  const receipt = join(dataDir, 'mobile-ready.json');
  rmSync(receipt, { force: true });
  const mobile = startBridge({ ...config, assets, generation,
    ready: () => {
      const temp = `${receipt}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ pid: process.pid, generation: generation.id, assets }), { mode: 0o600 });
      renameSync(temp, receipt);
    },
    updating: () => existsSync(join(dirname(dataDir), 'hot-install-pending.json')), tls: { cert: readFileSync(config.certFile), key: readFileSync(config.keyFile) },
    google: config.google ? new GoogleAuth(config.origin, () => GoogleCredentials.parse(privateJSON(config.google!.credentialsFile))) : undefined,
    clients: () => Clients.parse(privateJSON(config.clientsFile)), ledger: new MutationLedger(join(dataDir, 'mobile-mutations')), core }, failed);
  closeWithCore(core, mobile);
  return mobile;
}
