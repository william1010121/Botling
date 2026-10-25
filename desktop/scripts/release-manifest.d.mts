import type { KeyObject } from "node:crypto";
export interface Manifest { version: string; sha256: string; size: number; signature: string }
export function payload(manifest: Omit<Manifest, "signature">): Buffer;
export function trustKey(pem: string | null): KeyObject;
export function verifyManifest(manifest: unknown, pem: string | null): Manifest;
