/**
 * auth.mjs — password hashing + sessions, ZERO deps (node:crypto scrypt).
 * Slice-1 auth is email+password; OAuth providers land in the identities
 * table later without touching this surface.
 */
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  const hash = scryptSync(password, Buffer.from(saltHex, "hex"), 32);
  return timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
}

export const newToken = () => randomBytes(32).toString("hex");
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

export const validHandle = (h) => /^[a-z0-9][a-z0-9-]{1,31}$/.test(h ?? "");
export const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e ?? "");
