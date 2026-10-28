#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { plan } from './driver.mjs';
// Intentionally no dynamic runtime loading and no production execution path.
try {
  const [mode, inputFile, trustFile, ...extra] = process.argv.slice(2);
  if (mode !== 'plan' || !inputFile || !trustFile || extra.length) throw new Error('Usage: node cli.mjs plan INPUT.json REVIEWED-release-config.json. Live execution blocked pending reviewed runtime bridge and explicit install approval.');
  const input = JSON.parse(readFileSync(inputFile, 'utf8'));
  const { publicKey } = JSON.parse(readFileSync(trustFile, 'utf8'));
  console.log(JSON.stringify(plan(input, publicKey), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
