/** Read-only launch check for the exact assets emitted by a public project view. */
import { extname } from "node:path";

const MAX_BYTES = 32 * 1024 * 1024;
const SAMPLE_LIMIT = 32;
const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "webp", "svg"]);
const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
  pdf: "application/pdf", json: "application/json", css: "text/css", txt: "text/plain",
  md: "text/markdown", csv: "text/csv", yaml: "text/yaml", yml: "text/yaml",
  icc: "application/vnd.iccprofile", icm: "application/vnd.iccprofile",
  zip: "application/zip", vtt: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ogg: "audio/ogg", mp3: "audio/mpeg", glb: "model/gltf-binary", gltf: "model/gltf+json",
  stl: "model/stl", obj: "model/obj", mtl: "text/plain",
};
class PreviewAssetError extends Error {}
const fail = detail => { throw new PreviewAssetError(`Public preview assets: ${detail}`); };

async function get(url, signal, label, maxBytes = MAX_BYTES) {
  const response = await fetch(url, { redirect: "manual", credentials: "omit",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  if (response.status !== 200) {
    await response.body?.cancel();
    fail(`${label} returned HTTP ${response.status}`);
  }
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    fail(`${label} exceeds the response size limit`);
  }
  const reader = response.body?.getReader(), chunks = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          fail(`${label} exceeds the response size limit`);
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  if (!size) fail(`${label} returned an empty body`);
  return { bytes: Buffer.concat(chunks, size), mime: (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() };
}

async function getJson(url, signal, label, limit) {
  const { bytes, mime } = await get(url, signal, label, limit);
  if (mime !== "application/json") fail(`${label} did not return JSON`);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail(`${label} returned invalid JSON`); }
}

function assetUrls(view, origin, slug, ref) {
  const prefix = `/api/games/${encodeURIComponent(slug)}/assets/`, found = new Map(), pending = [view];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") {
      // Match complete absolute URLs first: an external URL containing our
      // route must never be mistaken for a relative same-origin request.
      const tokens = value.replaceAll("&amp;", "&").match(/(?:https?:)?\/\/[^\s"'<>()[\]{}\\]+|\/api\/games\/[^\s"'<>()[\]{}\\]+/g) || [];
      for (const token of tokens) {
        let url;
        try { url = new URL(token, origin); } catch { continue; }
        if (url.origin !== origin || !url.pathname.startsWith(prefix)) continue;
        let relative;
        try { relative = decodeURIComponent(url.pathname.slice(prefix.length)); }
        catch { fail("the project view contains an invalid asset path"); }
        if (!relative || relative.split("/").some(part => part === "." || part === "..")
          || /[\\\u0000-\u001f\u007f]/.test(relative) || url.username || url.password || url.hash)
          fail("the project view contains an unsafe asset path");
        if (url.searchParams.getAll("ref").length !== 1 || url.searchParams.get("ref") !== ref)
          fail("a project asset is missing its exact source ref or uses a different ref");
        found.set(url.href, { url, extension: extname(relative).slice(1).toLowerCase() });
      }
    } else if (value && typeof value === "object") pending.push(...Object.values(value));
  }
  return [...found.values()];
}

function checkDeclaredPrintingAssets(view, origin, slug, ref) {
  const prefix = `/api/games/${encodeURIComponent(slug)}/assets/`, first = new Set();
  const checkLocal = (declared, emitted) => {
    if (typeof declared !== "string" || !declared || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(declared)) return;
    const local = declared.replace(/^(?:\.\/)+/, "");
    // build_hub emits local files outside assets/ as embedded data, and local
    // assets/ files as exact URLs. A missing file leaves only the declaration:
    // healthy icons must not conceal that missing card artwork.
    if (!local.startsWith("assets/")) {
      if (typeof emitted !== "string" || !/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,.+/is.test(emitted))
        fail("declared local card artwork is missing from the project view");
      return;
    }
    let url, relative;
    try {
      url = new URL(String(emitted || "").replaceAll("&amp;", "&"), origin);
      relative = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch { fail("declared local card artwork is missing its exact asset URL"); }
    if (url.origin !== origin || !url.pathname.startsWith(prefix) || relative !== local.slice("assets/".length)
      || url.searchParams.getAll("ref").length !== 1 || url.searchParams.get("ref") !== ref)
      fail("declared local card artwork is missing its exact asset URL");
  };
  for (const printing of view.printings) {
    if (!printing || typeof printing !== "object") continue;
    checkLocal(printing.art, printing.art_data);
    // The generated card view exposes the first printing's composed scan for
    // each card, rather than every alternate printing's scan.
    if (!first.has(printing.card_id)) {
      first.add(printing.card_id);
      checkLocal(printing.scan, printing.scan_data || view.scans?.[printing.card_id]);
    }
  }
}

function checkBytes({ bytes, mime }, extension) {
  const expected = MIME[extension];
  if (!expected) fail("the sampled view contains an unsupported asset type");
  if (mime !== expected) fail(`a ${extension} asset returned the wrong media type`);
  const start = bytes.subarray(0, 1024).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1(?:\s|$)/.test(start)) fail("an asset returned a Git LFS pointer instead of file bytes");
  if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(start)) fail("an asset returned an HTML page instead of file bytes");
  const ascii = (at, length) => bytes.subarray(at, at + length).toString("ascii");
  let valid = false;
  switch (extension) {
    case "png": valid = bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && ascii(12, 4) === "IHDR" && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
      && ascii(bytes.length - 8, 4) === "IEND"; break;
    case "jpg": case "jpeg": valid = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216
      && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217; break;
    case "webp": valid = bytes.length >= 20 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP"
      && ["VP8 ", "VP8L", "VP8X"].includes(ascii(12, 4)) && bytes.readUInt32LE(4) + 8 === bytes.length; break;
    case "svg": {
      const xml = bytes.toString("utf8").replace(/^\uFEFF/, "").replace(/<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/gi, "").trim();
      valid = /^<svg(?:\s|>)/i.test(xml) && /(?:<\/svg\s*>|\/>)\s*$/i.test(xml); break;
    }
    case "ttf": valid = bytes.length >= 12 && (bytes.readUInt32BE(0) === 0x00010000 || ascii(0, 4) === "true") && bytes.readUInt16BE(4) > 0; break;
    case "otf": valid = bytes.length >= 12 && ascii(0, 4) === "OTTO" && bytes.readUInt16BE(4) > 0; break;
    case "woff": case "woff2": valid = bytes.length >= (extension === "woff" ? 44 : 48)
      && ascii(0, 4) === (extension === "woff" ? "wOFF" : "wOF2") && bytes.readUInt32BE(8) === bytes.length; break;
    case "pdf": valid = ascii(0, 5) === "%PDF-" && bytes.subarray(-1024).includes(Buffer.from("%%EOF")); break;
    case "icc": case "icm": valid = bytes.length >= 128 && ascii(36, 4) === "acsp" && bytes.readUInt32BE(0) === bytes.length; break;
    case "zip": case "vtt": case "xlsx": valid = bytes.length >= 22 && bytes[0] === 80 && bytes[1] === 75
      && [0x0403, 0x0605].includes(bytes.readUInt16LE(2)); break;
    case "ogg": valid = bytes.length >= 27 && ascii(0, 4) === "OggS"; break;
    case "mp3": valid = bytes.length >= 10 && (ascii(0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0)); break;
    case "glb": valid = bytes.length >= 12 && ascii(0, 4) === "glTF" && bytes.readUInt32LE(8) === bytes.length; break;
    case "stl": valid = (bytes.length >= 84 && bytes.readUInt32LE(80) * 50 + 84 === bytes.length)
      || (/^solid\s/m.test(start) && /\bendsolid\b/.test(bytes.subarray(-1024).toString("utf8"))); break;
    case "json": case "gltf": try { JSON.parse(bytes.toString("utf8")); valid = true; } catch {} break;
    default: valid = !bytes.includes(0) && bytes.toString("utf8").trim().length > 0;
  }
  // File signatures complement the browser's image/font decoding regression;
  // this HTTP audit does not claim full native format validation.
  if (!valid) fail(`a ${extension} asset returned invalid file bytes`);
}

export async function checkPublicPreviewAssets(origin, { slug } = {}) {
  const abort = new AbortController();
  try {
    let base;
    try { base = new URL(origin); } catch { fail("the origin is invalid"); }
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password
      || base.pathname !== "/" || base.search || base.hash) fail("the origin must have no path or credentials");
    origin = base.origin;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]);
    if (!slug) {
      const catalog = await getJson(new URL("/api/catalog?limit=24", origin), signal, "public catalog", 1024 * 1024);
      slug = catalog?.items?.find(item => item && item.visibility === "public")?.slug;
      if (!slug) fail("no public project is available; publish an asset-bearing project before launch");
    }
    if (typeof slug !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.\/-]{0,199}$/.test(slug)
      || slug.split("/").some(part => !part || part === "." || part === "..")) fail("the selected project slug is invalid");
    const view = await getJson(new URL(`/api/games/${encodeURIComponent(slug)}/ui`, origin), signal, "public project view");
    const ref = view?.source_ref;
    if (typeof ref !== "string" || !/^[a-f0-9]{40}$/i.test(ref)) fail("the public project view has no exact source ref");
    const nonempty = value => typeof value === "string" && value.trim().length > 0;
    const cardIds = new Set((Array.isArray(view.cards) ? view.cards : [])
      .filter(card => card && nonempty(card.id) && nonempty(card.name) && nonempty(card.type)).map(card => card.id));
    if (!cardIds.size || !(Array.isArray(view.printings) && view.printings.some(printing => printing
      && nonempty(printing.id) && nonempty(printing.set_id) && cardIds.has(printing.card_id))))
      fail("the public project has no card with a matching printing; select a card project with --preview-game");
    checkDeclaredPrintingAssets(view, origin, slug, ref);
    const assets = assetUrls(view, origin, slug, ref);
    if (!assets.length) fail("the public project has no versioned assets; select an asset-bearing public project with --preview-game");
    if (!assets.some(asset => IMAGE_TYPES.has(asset.extension)))
      fail("the public card project has no versioned image assets; select an image-bearing card project with --preview-game");
    // Include every available extension before filling remaining sample slots,
    // so a large art library cannot hide a broken font or symbol endpoint.
    const representatives = new Map();
    for (const asset of assets) if (!representatives.has(asset.extension)) representatives.set(asset.extension, asset);
    if (representatives.size > SAMPLE_LIMIT) fail("the view has too many asset types for the bounded launch sample");
    const sample = [...representatives.values()];
    for (const asset of assets) if (sample.length < SAMPLE_LIMIT && !sample.includes(asset)) sample.push(asset);
    let next = 0, failure;
    await Promise.all(Array.from({ length: Math.min(4, sample.length) }, async () => {
      try {
        while (next < sample.length && !failure) {
          const asset = sample[next++];
          checkBytes(await get(asset.url, signal, `${asset.extension || "unknown"} asset`), asset.extension);
        }
      } catch (error) { failure ||= error; abort.abort(); }
    }));
    if (failure) throw failure;
    return { slug, ref, checked: sample.length, total: assets.length };
  } catch (error) {
    abort.abort();
    if (error instanceof PreviewAssetError) throw error;
    fail("a request failed or timed out");
  }
}
