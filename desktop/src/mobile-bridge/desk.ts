/** What the desktop's Phone settings (and `pair.cjs`) do with pairing: make a one-time link, list the paired
 * phones, end one. The same store the bridge reads, so a revoked phone is refused on its next request. Local
 * and owner-only by construction: it is reached only through the core's renderer commands, never the bridge.
 * The link is returned to the caller once and neither stored nor logged here. */
import { PairingStore, pairingURL, type Device, type Route } from './pairing';

export interface MobileDeskView { enabled: boolean; routes: Route[]; devices: Device[] }
export interface MobilePairView { url: string; expiresAt: number; route: Route }

export class MobileDesk {
  constructor(private store: PairingStore, private routes: Route[]) {}
  view(): MobileDeskView { return { enabled: true, routes: this.routes.map(r => ({ ...r })), devices: this.store.devices() }; }
  /** `route` is an index into the ordered routes (default: the first). */
  pair(botIds: string[], route = 0): MobilePairView {
    const chosen = this.routes[route];
    if (!chosen) throw new Error('Unknown route.');
    const offer = this.store.createOffer(botIds);
    return { url: pairingURL(chosen.origin, this.store.coreId(), offer.secret), expiresAt: offer.expiresAt, route: { ...chosen } };
  }
  revoke(deviceId: string): MobileDeskView { this.store.revoke(deviceId); return this.view(); }
}
export const OFF: MobileDeskView = { enabled: false, routes: [], devices: [] };
