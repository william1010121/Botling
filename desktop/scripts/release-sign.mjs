// Explicit operator tool. Only this process reads private key bytes; never publishes.
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, statSync, lstatSync, openSync, fstatSync, closeSync, constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { payload } from "./release-manifest.mjs";

function privateKeyFromFile(path) {
  if (!isAbsolute(path)) throw new Error('Invalid key path');
  const before = lstatSync(path);
  const validate = stat => {
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid key file');
    if (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600)) throw new Error('Invalid key ownership/mode');
  };
  validate(before);
  // No-follow closes the leaf-symlink race; non-blocking prevents a substituted FIFO hanging.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const opened = fstatSync(fd); validate(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Key file changed');
    bytes = readFileSync(fd);
    return createPrivateKey(bytes);
  } finally { bytes?.fill(0); closeSync(fd); }
}

try {
  const args = process.argv.slice(2), command = args.shift();
  const option = args.indexOf('--key-file');
  let explicitFile;
  if (option >= 0) {
    explicitFile = args[option + 1];
    if (!explicitFile || explicitFile.startsWith('--')) throw new Error('Missing key path');
    args.splice(option, 2);
  }
  const folder = join(homedir(), '.botling-release');
  const selectedFile = explicitFile ?? process.env.BOTLING_RELEASE_KEY_FILE;
  if (selectedFile !== undefined && (!selectedFile || !isAbsolute(selectedFile))) throw new Error('Invalid key path');
  if (command === 'keygen' && !args.length && selectedFile === undefined) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const keys = generateKeyPairSync('ed25519');
    writeFileSync(join(folder, 'ed25519.key'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    writeFileSync(join(folder, 'ed25519.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o644 });
    console.log('Created ~/.botling-release/ed25519.key (600) and ed25519.pub. Embed the public key in desktop/release-config.json before building.');
  } else {
    if (!((command === 'preflight' && args.length === 0) || (command === 'sign' && args.length === 2 && !args.some(arg => arg.startsWith('--'))))) throw new Error('Invalid arguments');
    // Preserve CI's existing PEM-secret input, but never silently prefer it over a file selection.
    if (selectedFile !== undefined && process.env.BOTLING_RELEASE_KEY) throw new Error('Ambiguous key input');
    const key = selectedFile !== undefined ? privateKeyFromFile(selectedFile)
      : process.env.BOTLING_RELEASE_KEY ? createPrivateKey(process.env.BOTLING_RELEASE_KEY)
        : privateKeyFromFile(join(folder, 'ed25519.key'));
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid key type');
    const config = JSON.parse(readFileSync(new URL('../release-config.json', import.meta.url), 'utf8'));
    const trust = createPublicKey(config.publicKey);
    if (trust.asymmetricKeyType !== 'ed25519' || !trust.equals(createPublicKey(key))) throw new Error('Trust mismatch');
    // Successful preflight is deliberately silent and creates/signs no artifact.
    if (command === 'sign') {
      const [version, zip] = args;
      const manifest = { version: version.replace(/^v/, ''), sha256: createHash('sha256').update(readFileSync(zip)).digest('hex'), size: statSync(zip).size };
      const signature = sign(null, payload(manifest), key).toString('base64');
      writeFileSync(`${zip}.manifest.json`, JSON.stringify({ ...manifest, signature }, null, 2) + '\n');
      console.log(`Signed ${zip}.manifest.json`);
    }
  }
} catch {
  // Never forward OpenSSL/fs errors, arguments, key paths, PEM, or exception stacks.
  console.error('Release signing failed: invalid arguments, key input, trust, or artifact.');
  process.exitCode = 1;
}
