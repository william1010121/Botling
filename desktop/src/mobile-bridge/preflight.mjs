#!/usr/bin/env node
// Read-only, offline readiness check. No listener, credential issuance, DNS, or trust changes.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';

let stage = 'config';
function requireValue(ok) { if (!ok) throw new Error('invalid'); }
function ownerFile(file) {
  const s = statSync(file);
  requireValue(s.isFile() && !(s.mode & 0o077) && (!process.getuid || s.uid === process.getuid()));
}
try {
  const file = process.argv[2];
  requireValue(process.argv.length === 3 && file && isAbsolute(file));
  ownerFile(file);
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const keys = ['origin', 'host', 'port', 'certFile', 'keyFile', 'clientsFile', 'assets'];
  requireValue(c && Object.keys(c).every(k => keys.includes(k) || k === 'google') /* removed field of older configs: ignored */ && keys.every(k => Object.hasOwn(c, k)));
  requireValue(['certFile', 'keyFile', 'clientsFile', 'assets'].every(k => typeof c[k] === 'string' && isAbsolute(c[k])));
  stage = 'private bind and HTTPS origin';
  requireValue(typeof c.host === 'string' && isIP(c.host) === 4);
  const [a, b] = c.host.split('.').map(Number);
  requireValue(a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127));
  const origin = new URL(c.origin);
  requireValue(origin.protocol === 'https:' && origin.origin === c.origin && Number.isInteger(c.port) && c.port >= 1 && c.port <= 65535);
  requireValue(Object.values(networkInterfaces()).flat().some(n => n?.address === c.host));
  stage = 'TLS key, certificate, validity and hostname';
  ownerFile(c.keyFile);
  const cert = readFileSync(c.certFile), key = readFileSync(c.keyFile);
  const x509 = new X509Certificate(cert);
  requireValue(Date.parse(x509.validFrom) <= Date.now() && Date.parse(x509.validTo) > Date.now());
  requireValue(isIP(origin.hostname) ? x509.checkIP(origin.hostname) : x509.checkHost(origin.hostname, { subject: 'never' }));
  createSecureContext({ cert, key, minVersion: 'TLSv1.2' });
  stage = 'client policy';
  ownerFile(c.clientsFile);
  const clients = JSON.parse(readFileSync(c.clientsFile, 'utf8'));
  requireValue(Array.isArray(clients));
  const clientKeys = ['id', 'tokenHash', 'botIds', 'expiresAt'];
  requireValue(clients.every(v => v && Object.keys(v).length === 4 && clientKeys.every(k => Object.hasOwn(v, k)) && typeof v.id === 'string' && v.id.length > 0 && v.id.length <= 100 && typeof v.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(v.tokenHash) && Array.isArray(v.botIds) && v.botIds.length > 0 && v.botIds.every(b => typeof b === 'string' && b.length > 0) && Number.isInteger(v.expiresAt) && v.expiresAt > 0));
  requireValue(new Set(clients.map(v => v.id)).size === clients.length);
  requireValue(clients.some(v => v.expiresAt > Date.now() && v.botIds.includes('6A0B0000-0000-4000-8000-000000000002')));
  stage = 'packaged web assets';
  for (const name of ['index.html', 'web.js', 'styles.css', 'web.css', 'chat.html', 'chat.js', 'chat.css', 'frame.css', 'frame-host.html', 'frame-host.js', 'manifest.webmanifest', 'icon.svg']) {
    requireValue(statSync(join(c.assets, name)).isFile() && readFileSync(join(c.assets, name)).length > 0);
  }
  console.log('PASS: local configuration, bind address, TLS material, Main grant and assets. No listener started.');
  console.log('UNVERIFIED: phone DNS/reachability, CA trust/chain, available port, live core, token possession and device interaction.');
  if (a === 127) console.log('LOCAL BACKEND: phone access requires a local connector and configured edge route; loopback alone is not remotely reachable.');
} catch {
  // Do not print exception bodies: malformed config/PEM errors can contain private input.
  console.error(`FAIL: ${stage}. See LOCAL-SETUP.md; no service or configuration was changed.`);
  process.exitCode = 1;
}
