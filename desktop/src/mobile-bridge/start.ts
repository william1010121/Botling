import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { Clients, privateJSON, startBridge, type MobileCore } from './bridge';
import { MutationLedger } from './ledger';
import { closeWithCore } from './lifecycle';

const absolute = z.string().refine(isAbsolute);
const Config = z.strictObject({ origin: z.string().url(), host: z.string(), port: z.number().int().min(1).max(65535),
  certFile: absolute, keyFile: absolute, clientsFile: absolute, assets: absolute });
/** Disabled unless the local owner explicitly sets BOTLING_MOBILE_CONFIG before core startup.
 * Journal location is fixed under core data; changing TLS/config cannot reset deduplication. */
export function startConfiguredMobile(core: MobileCore & { shutdown(): Promise<void> }, dataDir: string, failed: (error: Error) => void) {
  if (process.env.BOTLING_CORE_PROBE === '1') return null;
  const file = process.env.BOTLING_MOBILE_CONFIG;
  if (!file) return null;
  const config = Config.parse(privateJSON(file));
  const mobile = startBridge({ ...config, tls: { cert: readFileSync(config.certFile), key: readFileSync(config.keyFile) },
    clients: () => Clients.parse(privateJSON(config.clientsFile)), ledger: new MutationLedger(join(dataDir, 'mobile-mutations')), core }, failed);
  closeWithCore(core, mobile);
  return mobile;
}
