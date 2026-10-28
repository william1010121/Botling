import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { Clients, privateJSON, startBridge, type MobileCore } from './bridge';
import { MutationLedger } from './ledger';
import { AccessAccounts, AccessAuth, AccessConfig } from './access';
import { closeWithCore } from './lifecycle';

const absolute = z.string().refine(isAbsolute);
const Config = z.strictObject({ origin: z.string().url(), host: z.string(), port: z.number().int().min(1).max(65535),
  access: AccessConfig.extend({ accountsFile: absolute }).optional(), certFile: absolute, keyFile: absolute, clientsFile: absolute, assets: absolute });
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
  const mobile = startBridge({ ...config, tls: { cert: readFileSync(config.certFile), key: readFileSync(config.keyFile) },
    access: config.access ? new AccessAuth(config.access, () => AccessAccounts.parse(privateJSON(config.access!.accountsFile))) : undefined,
    clients: () => Clients.parse(privateJSON(config.clientsFile)), ledger: new MutationLedger(join(dataDir, 'mobile-mutations')), core }, failed);
  closeWithCore(core, mobile);
  return mobile;
}
