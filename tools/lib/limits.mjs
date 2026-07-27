// @ts-check
/**
 * limits.mjs — Store-1 caps and allowlists, LOCKED as code (SPEC §7).
 * One source of truth: LFS client, add-asset, server, and editor all import this.
 */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;      // 25 MB per file (SPEC §7)
export const REPO_SOFT_CAP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB per repo at v1
export const ALLOWED_ASSET_EXT = new Set(
  ["png", "jpg", "jpeg", "webp", "svg", "ogg", "mp3", "woff2"]);
export const LFS_TRACK_PATTERN = "assets/**";          // the only LFS path (SPEC §7)

export function assertAssetAllowed(filename, byteLength) {
  const ext = filename.toLowerCase().split(".").pop();
  if (!ALLOWED_ASSET_EXT.has(ext))
    throw new Error(`asset type '.${ext}' not allowed (SPEC §7: ${[...ALLOWED_ASSET_EXT].join(", ")})`);
  if (byteLength > MAX_ASSET_BYTES)
    throw new Error(`asset is ${(byteLength / 1048576).toFixed(1)} MB; cap is ${MAX_ASSET_BYTES / 1048576} MB (SPEC §7)`);
}
