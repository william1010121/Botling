// Plugins' secret settings (passwords, tokens): 1.x keeps them in the macOS keychain (Secrets.swift);
// 2.0 seals each with Electron's safeStorage (the OS keychain / DPAPI / libsecret key) and keeps only
// the sealed bytes, base64, in <core>/plugin-secrets.json (0600). Plain text never touches a file,
// plugins.json, a chat or a page. safeStorage exists only in Electron's main process, so the core asks
// main to seal and open (`Sealer`); the opened values stay in the core's memory, for the plugin host's
// program parts and the environment of bots' MCP servers.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../durable/atomic";

/** Seals and opens text; a rejected promise when the OS offers no safe storage. */
export interface Sealer {
  seal(text: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

export interface SecretStore {
  get(plugin: string, key: string): string | null;
  /** null or "" takes the secret out. */
  set(plugin: string, key: string, value: string | null): Promise<void>;
  has(plugin: string, key: string): boolean;
}

/** For tests: secrets in memory (1.x's `MemorySecretStore`). */
export class MemorySecretStore implements SecretStore {
  private values = new Map<string, string>();
  get(plugin: string, key: string) { return this.values.get(`${plugin}\u0000${key}`) ?? null; }
  has(plugin: string, key: string) { return this.values.has(`${plugin}\u0000${key}`); }
  async set(plugin: string, key: string, value: string | null) {
    if (value) this.values.set(`${plugin}\u0000${key}`, value);
    else this.values.delete(`${plugin}\u0000${key}`);
  }
}

type SealedFile = Record<string, Record<string, string>>;

/** Sealed secrets in a file; opened once at start (`load`), sealed on every change. */
export class SealedSecretStore implements SecretStore {
  private sealed: SealedFile = {};
  private open = new Map<string, string>();
  /** Why secrets cannot be read or kept here (no safe storage), or null. */
  problem: string | null = null;

  constructor(private readonly file: string, private readonly sealer: Sealer | null) {
    if (!sealer) this.problem = "There is no safe storage here, so plugins' secrets cannot be kept.";
  }

  /** Reads the file and opens what it holds; a value that cannot be opened is left sealed (and unknown). */
  async load(): Promise<void> {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [plugin, keys] of Object.entries(value as Record<string, unknown>)) {
          if (!keys || typeof keys !== "object" || Array.isArray(keys)) continue;
          for (const [key, sealed] of Object.entries(keys as Record<string, unknown>)) {
            if (typeof sealed === "string") (this.sealed[plugin] ??= {})[key] = sealed;
          }
        }
      }
    } catch { /* none yet */ }
    if (!this.sealer) return;
    for (const [plugin, keys] of Object.entries(this.sealed)) {
      for (const [key, sealed] of Object.entries(keys)) {
        try {
          this.open.set(`${plugin}\u0000${key}`, await this.sealer.open(sealed));
        } catch (error) {
          this.problem = `A sealed secret could not be opened: ${(error as Error).message}`;
        }
      }
    }
  }

  get(plugin: string, key: string) { return this.open.get(`${plugin}\u0000${key}`) ?? null; }
  has(plugin: string, key: string) { return this.open.has(`${plugin}\u0000${key}`) || !!this.sealed[plugin]?.[key]; }

  async set(plugin: string, key: string, value: string | null) {
    if (value) {
      if (!this.sealer) throw new Error(this.problem ?? "There is no safe storage here.");
      const sealed = await this.sealer.seal(value);
      (this.sealed[plugin] ??= {})[key] = sealed;
      this.open.set(`${plugin}\u0000${key}`, value);
    } else {
      if (this.sealed[plugin]) {
        delete this.sealed[plugin][key];
        if (!Object.keys(this.sealed[plugin]).length) delete this.sealed[plugin];
      }
      this.open.delete(`${plugin}\u0000${key}`);
    }
    writeFileAtomic(this.file, JSON.stringify(this.sealed, null, 2)); // written 0600
  }
}

/**
 * A sealer for tests and headless runs (`BOTLING_TEST_SEAL_KEY`): AES-256-GCM under a key from that
 * variable. Never used by the app itself, which seals with safeStorage through main.
 */
export function testSealer(secret: string): Sealer {
  const key = createHash("sha256").update(secret).digest();
  return {
    async seal(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    },
    async open(sealed) {
      const data = Buffer.from(sealed, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

/** The sealer main offers over the core's port: `{botling: "seal"}` out, `{botling: "sealed"}` back. */
export class PortSealer implements Sealer {
  private next = 0;
  private waiting = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();
  constructor(private readonly post: (message: { botling: "seal"; id: number; op: "seal" | "open"; text: string }) => void) {}

  private ask(op: "seal" | "open", text: string): Promise<string> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.post({ botling: "seal", id, op, text });
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error("Safe storage did not answer.")); }, 10_000).unref?.();
    });
  }
  seal(text: string) { return this.ask("seal", text); }
  open(sealed: string) { return this.ask("open", sealed); }

  /** Main's answer. */
  answer(message: { id?: unknown; ok?: unknown; text?: unknown; error?: unknown }) {
    if (typeof message.id !== "number") return;
    const waiter = this.waiting.get(message.id);
    if (!waiter) return;
    this.waiting.delete(message.id);
    if (message.ok === true && typeof message.text === "string") waiter.resolve(message.text);
    else waiter.reject(new Error(typeof message.error === "string" ? message.error : "Safe storage refused."));
  }
}
