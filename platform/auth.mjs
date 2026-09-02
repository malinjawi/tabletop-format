/**
 * auth.mjs — password hashing + sessions, ZERO deps (node:crypto scrypt).
 * Slice-1 auth is email+password; OAuth providers land in the identities
 * table later without touching this surface.
 */
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";

const MAX_PASSWORD_BYTES = 256;

function passwordBytes(password) {
  const bytes = Buffer.from(String(password ?? ""));
  if (bytes.length > MAX_PASSWORD_BYTES)
    throw Object.assign(new Error("password is too long"), { status: 422 });
  return bytes;
}

export function hashPassword(password) {
  const input = passwordBytes(password);
  const salt = randomBytes(16);
  const hash = scryptSync(input, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `s2$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  try {
    const input = passwordBytes(password), encoded = String(stored || "");
    const modern = encoded.startsWith("s2$");
    const [saltHex, hashHex] = modern ? encoded.slice(3).split("$") : encoded.split(":");
    if (!/^[0-9a-f]{32}$/i.test(saltHex || "") || !/^[0-9a-f]{64}$/i.test(hashHex || "")) return false;
    const hash = modern
      ? scryptSync(input, Buffer.from(saltHex, "hex"), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
      : scryptSync(input, Buffer.from(saltHex, "hex"), 32);
    return timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
  } catch { return false; }
}

export const newToken = () => randomBytes(32).toString("hex");
// Only this one-way digest is persisted. A database read cannot become a live
// browser/API session without the original random token.
export const tokenDigest = token => createHash("sha256").update(String(token)).digest("hex");
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

export const validHandle = (h) => /^[a-z0-9][a-z0-9-]{1,31}$/.test(h ?? "");
export const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e ?? "");
