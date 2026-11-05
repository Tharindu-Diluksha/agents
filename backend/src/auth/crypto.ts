import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Small crypto helpers for sessions:
 * - session ids are random 256-bit values; only their SHA-256 is stored, so a
 *   database leak doesn't hand out live sessions;
 * - refresh tokens and the short-lived login cookie are sealed with
 *   AES-256-GCM under a key derived from SESSION_SECRET.
 */

export function randomId(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string, purpose: string) {
    if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
    this.key = Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.alloc(0), Buffer.from(`orchestrator:${purpose}`), 32));
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }

  /** Returns null for anything tampered with, truncated, or sealed under another key/purpose. */
  open(sealed: string): string | null {
    try {
      const raw = Buffer.from(sealed, "base64url");
      if (raw.length < 29) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}
