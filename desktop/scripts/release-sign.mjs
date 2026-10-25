// Explicit operator tool. Never called by build/package; never publishes or generates keys implicitly.
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { payload } from "./release-manifest.mjs";
const [command, version, zip] = process.argv.slice(2);
const folder = join(homedir(), ".botling-release");
const keyFile = join(folder, "ed25519.key");
if (command === "keygen") {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const keys = generateKeyPairSync("ed25519");
  // Exclusive creation refuses to overwrite an existing identity. Private key is mode 600 from creation.
  writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  writeFileSync(join(folder, "ed25519.pub"), keys.publicKey.export({ type: "spki", format: "pem" }), { flag: "wx", mode: 0o644 });
  console.log("Created ~/.botling-release/ed25519.key (600) and ed25519.pub. Embed the public key in desktop/release-config.json before building.");
} else if (command === "sign" && version && zip) {
  const key = createPrivateKey(process.env.BOTLING_RELEASE_KEY || readFileSync(keyFile, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Release key must be Ed25519");
  const config = JSON.parse(readFileSync(new URL("../release-config.json", import.meta.url), "utf8"));
  const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  if (config.publicKey !== publicKey) throw new Error("Signing key does not match release-config.json; rebuild with the matching public trust first");
  const manifest = { version: version.replace(/^v/, ""), sha256: createHash("sha256").update(readFileSync(zip)).digest("hex"), size: statSync(zip).size };
  const signature = sign(null, payload(manifest), key).toString("base64");
  writeFileSync(`${zip}.manifest.json`, JSON.stringify({ ...manifest, signature }, null, 2) + "\n");
  console.log(`Signed ${zip}.manifest.json`);
} else {
  console.error("Usage: node scripts/release-sign.mjs keygen | sign <2.x.y> <zip>");
  process.exitCode = 2;
}
