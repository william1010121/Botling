/** Local, OS-authenticated: `node pair.cjs PAIRING_DIR ORIGIN BOT_ID...` prints a one-time pairing URL (valid 5 minutes)
 * for a QR code. The URL is the only output on stdout; it is a secret until used or expired. */
import { PairingStore, pairingURL } from './pairing';

const [dir, origin, ...bots] = process.argv.slice(2);
if (!dir || !origin || !bots.length) { console.error('Usage: pair.cjs PAIRING_DIR ORIGIN BOT_ID...'); process.exit(2); }
try {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.origin !== origin) throw new Error('ORIGIN must be an https origin without a path.');
  const store = new PairingStore(dir);
  const offer = store.createOffer(bots);
  console.log(pairingURL(origin, store.coreId(), offer.secret));
  console.error('One-time pairing link. Expires in 5 minutes; works once.');
} catch (error) { console.error((error as Error).message); process.exit(1); }
