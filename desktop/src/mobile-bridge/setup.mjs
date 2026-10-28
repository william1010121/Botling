#!/usr/bin/env node
// Local OS-authenticated setup only. Never run as an HTTP endpoint; never print tokens.
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const [action, policyArg, clientId, ...args] = process.argv.slice(2);
if (!['issue', 'revoke'].includes(action) || !policyArg || !/^[A-Za-z0-9_-]{1,100}$/.test(clientId ?? '')) {
  throw new Error('Usage: node setup.mjs issue POLICY CLIENT_ID TOKEN_OUTPUT BOT_ID... | revoke POLICY CLIENT_ID');
}
const policy = resolve(policyArg);
let clients = [];
try {
  const stat = statSync(policy);
  if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Policy must be owned by this user with mode 0600.');
  clients = JSON.parse(readFileSync(policy, 'utf8'));
  if (!Array.isArray(clients)) throw new Error('Invalid policy');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
// Local setup concurrency is refused, never silently clobbers policy.
const lock = openSync(policy + '.setup-lock', 'wx', 0o600);
try {
  // Re-read while locked in case a previous setup completed during initial validation.
  try { clients = JSON.parse(readFileSync(policy, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (action === 'issue') {
    const [output, ...bots] = args;
    if (!output || !bots.length || bots.some(id => !/^[A-Za-z0-9_.:-]{1,64}$/.test(id))) throw new Error('Token output and explicit bot IDs required.');
    if (clients.some(c => c.id === clientId)) throw new Error('Client ID already exists; revoke first.');
    const token = randomBytes(32).toString('base64url');
    // O_EXCL prevents replacing an unrelated file. Token is never on stdout, command line or URL.
    writeFileSync(resolve(output), token + '\n', { flag: 'wx', mode: 0o600 });
    clients.push({ id: clientId, tokenHash: createHash('sha256').update(token).digest('hex'), botIds: bots, expiresAt: Date.now() + 30 * 86400_000 });
  } else clients = clients.filter(c => c.id !== clientId);
  const temp = join(dirname(policy), `.mobile-policy-${randomBytes(8).toString('hex')}`);
  writeFileSync(temp, JSON.stringify(clients, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, policy);
  console.log(action === 'issue' ? 'Client issued; token saved to the requested private file. Expires in 30 days.' : 'Client revoked.');
} finally {
  closeSync(lock);
  const { unlinkSync } = await import('node:fs'); unlinkSync(policy + '.setup-lock');
}
