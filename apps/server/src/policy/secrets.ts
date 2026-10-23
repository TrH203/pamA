// Hashing for PINs and one-time codes (scrypt from node:crypto: no native module in the sidecar)
// and HMAC-signed visitor cookies.
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(secret, salt, 32, { N: 16_384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [alg, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64url");
  const got = scryptSync(secret, Buffer.from(salt, "base64url"), want.length, {
    N: 16_384,
    r: 8,
    p: 1,
  });
  return got.length === want.length && timingSafeEqual(got, want);
}

export function sign(value: string, key: string): string {
  return `${value}.${createHmac("sha256", key).update(value).digest("base64url")}`;
}

export function unsign(signed: string, key: string): string | null {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const want = Buffer.from(sign(value, key).slice(i + 1));
  const got = Buffer.from(signed.slice(i + 1));
  return want.length === got.length && timingSafeEqual(want, got) ? value : null;
}

/** IPs are stored hashed only. */
export function hashIp(ip: string, key: string): string {
  return createHash("sha256").update(`${key}:${ip}`).digest("hex").slice(0, 32);
}
