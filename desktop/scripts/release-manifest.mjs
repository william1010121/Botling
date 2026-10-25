// Fixed wire format: UTF-8 JSON array [version, sha256, size]. No whitespace or trailing newline.
import { createPublicKey, verify } from "node:crypto";
export function payload(manifest) {
  if (!manifest || typeof manifest.version !== "string" || typeof manifest.sha256 !== "string" || !/^2\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
    || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.size)
    || manifest.size <= 0 || manifest.size > 512 * 1024 * 1024) throw new Error("Invalid release manifest");
  return Buffer.from(JSON.stringify([manifest.version, manifest.sha256, manifest.size]), "utf8");
}
export function trustKey(pem) {
  if (!pem) throw new Error("Update trust is not configured. Install a release with an embedded Ed25519 public key.");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Release trust must be Ed25519");
  return key;
}
export function verifyManifest(manifest, pem) {
  const key = trustKey(pem);
  const bytes = payload(manifest);
  if (typeof manifest.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(manifest.signature)
    || !verify(null, bytes, key, Buffer.from(manifest.signature, "base64"))) throw new Error("Invalid release signature");
  return manifest;
}
