/**
 * lfs.mjs — Git LFS batch-protocol client, ZERO dependencies (node fetch + crypto).
 *
 * THE LANDMINE WORKAROUND AS CODE (SPEC §7): Forgejo's contents API bypasses
 * .gitattributes, so platform writes must (1) upload the blob via this LFS batch
 * protocol, then (2) commit the matching 3-line pointer file in the same atomic
 * commit as any JSON changes. This module is the exact client that will speak to
 * Forgejo's `/{owner}/{repo}.git/info/lfs` endpoint; the mock server + e2e prove
 * it against the protocol; the Phase-1 spike re-proves it against real Forgejo.
 *
 * Protocol: https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md
 */
import { createHash } from "node:crypto";
import { assertAssetAllowed } from "./limits.mjs";

/** sha256 oid + canonical 3-line pointer text (spec v1). */
export function makePointer(buffer) {
  const oid = createHash("sha256").update(buffer).digest("hex");
  const size = buffer.length;
  return { oid, size,
    pointer: `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n` };
}

export function parsePointer(text) {
  const oid = (text.match(/^oid sha256:([0-9a-f]{64})$/m) ?? [])[1];
  const size = parseInt((text.match(/^size (\d+)$/m) ?? [])[1], 10);
  if (!oid || Number.isNaN(size)) throw new Error("not a valid LFS pointer");
  return { oid, size };
}

/** R2/Forgejo content-addressed key layout (SPEC §7). */
export const oidKey = (oid) => `lfs/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;

async function batch(lfsUrl, operation, objects, auth) {
  const res = await fetch(`${lfsUrl.replace(/\/$/, "")}/objects/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/vnd.git-lfs+json",
               "Accept": "application/vnd.git-lfs+json",
               ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ operation, transfers: ["basic"], objects }),
  });
  if (!res.ok) throw new Error(`LFS batch ${operation} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Upload a buffer; returns {oid, size, pointer}. Skips upload if server already has it (dedup). */
export async function uploadAsset(lfsUrl, filename, buffer, auth) {
  assertAssetAllowed(filename, buffer.length);
  const { oid, size, pointer } = makePointer(buffer);
  const rsp = await batch(lfsUrl, "upload", [{ oid, size }], auth);
  const obj = rsp.objects?.[0];
  if (obj?.error) throw new Error(`LFS: ${obj.error.message}`);
  const action = obj?.actions?.upload;
  if (action) { // absent action = server already has the object (content-addressed dedup)
    const up = await fetch(action.href, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", ...(action.header ?? {}) },
      body: buffer,
    });
    if (!up.ok) throw new Error(`LFS upload PUT failed: ${up.status}`);
    const verify = obj.actions?.verify;
    if (verify) {
      const v = await fetch(verify.href, { method: "POST",
        headers: { "Content-Type": "application/vnd.git-lfs+json", ...(verify.header ?? {}) },
        body: JSON.stringify({ oid, size }) });
      if (!v.ok) throw new Error(`LFS verify failed: ${v.status}`);
    }
  }
  return { oid, size, pointer };
}

/** Download by pointer text or {oid,size}; returns Buffer, sha-verified. */
export async function downloadAsset(lfsUrl, pointerOrObj, auth) {
  const { oid, size } = typeof pointerOrObj === "string" ? parsePointer(pointerOrObj) : pointerOrObj;
  const rsp = await batch(lfsUrl, "download", [{ oid, size }], auth);
  const action = rsp.objects?.[0]?.actions?.download;
  if (!action) throw new Error("LFS: no download action returned");
  const res = await fetch(action.href, { headers: action.header ?? {} });
  if (!res.ok) throw new Error(`LFS download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const gotOid = createHash("sha256").update(buf).digest("hex");
  if (gotOid !== oid) throw new Error(`LFS integrity failure: expected ${oid}, got ${gotOid}`);
  return buf;
}
