// Starts the relay connector with the core (core/main.ts). It connects only when the relay was turned on in
// Settings › Phone (`<data>/mobile/relay.json` has an address); until then it holds no socket and writes nothing.
import { join } from 'node:path';
import type { MobileCore } from '../mobile-bridge/bridge';
import { MutationLedger } from '../mobile-bridge/ledger';
import { closeWithCore } from '../mobile-bridge/lifecycle';
import { PairingStore } from '../mobile-bridge/pairing';
import { RelayConnector } from './connector';
import { RelayStore } from './store';

export function startRelay(core: MobileCore & { shutdown(): Promise<void> }, dataDir: string): RelayConnector | null {
  if (process.env.BOTLING_CORE_PROBE === '1') return null;
  const dir = join(dataDir, 'mobile');
  let ledger: MutationLedger | null = null;
  const connector = new RelayConnector({
    store: new RelayStore(dir), core,
    // The bridge's journal and core id: a phone is the same kind of client whichever way it comes in.
    ledger: () => ledger ??= new MutationLedger(join(dataDir, 'mobile-mutations')),
    coreId: () => new PairingStore(dir).coreId(),
  });
  connector.start();
  closeWithCore(core, { close: () => connector.stop() });
  return connector;
}
