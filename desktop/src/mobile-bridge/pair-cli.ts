/** Local, OS-authenticated, no network.
 * `node pair.cjs PAIRING_DIR ORIGIN BOT_ID...`  prints a one-time pairing URL (valid 5 minutes) for a QR code. The URL
 *   is the only output on stdout; it is a secret until used or expired.
 * `node pair.cjs devices PAIRING_DIR`           lists paired phones (device id, name, bots, expiry), never a token.
 * `node pair.cjs revoke PAIRING_DIR DEVICE_ID`  ends that phone's session. */
import { PairingStore, pairingURL } from './pairing';

const [first, second, third, ...rest] = process.argv.slice(2);
try {
  if (first === 'devices' && second) {
    for (const d of new PairingStore(second).devices())
      console.log([d.id, d.label || '-', d.botIds.join(','), new Date(d.expiresAt).toISOString()].join('\t'));
  } else if (first === 'revoke' && second && third) {
    if (!new PairingStore(second).revoke(third)) throw new Error('No paired phone with that device id.');
    console.error('Revoked.');
  } else {
    const dir = first, origin = second, bots = [third, ...rest].filter((b): b is string => !!b);
    if (!dir || !origin || !bots.length) { console.error('Usage: pair.cjs PAIRING_DIR ORIGIN BOT_ID... | devices PAIRING_DIR | revoke PAIRING_DIR DEVICE_ID'); process.exit(2); }
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) throw new Error('ORIGIN must be an https origin without a path.');
    const store = new PairingStore(dir);
    const offer = store.createOffer(bots);
    console.log(pairingURL(origin, store.coreId(), offer.secret));
    console.error('One-time pairing link. Expires in 5 minutes; works once.');
  }
} catch (error) { console.error((error as Error).message); process.exit(1); }
