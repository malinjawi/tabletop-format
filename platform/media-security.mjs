// Cheap, deterministic admission checks before untrusted media reaches Git/LFS
// or a renderer. These are not an antivirus replacement; they reject active
// SVG content, type confusion, and image decompression dimensions at the edge.
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 100_000_000;

function fail(message) { throw Object.assign(new Error(message), { status: 422 }); }
function dimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1)
    fail("image has invalid dimensions");
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS)
    fail(`image dimensions ${width}x${height} exceed Forge's decode limit`);
  return { width, height };
}
function jpegDimensions(buf) {
  let i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1]; i += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (i + 2 > buf.length) break;
    const length = buf.readUInt16BE(i);
    if (length < 2 || i + length > buf.length) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf))
      return dimensions(buf.readUInt16BE(i + 5), buf.readUInt16BE(i + 3));
    i += length;
  }
  fail("JPEG dimensions could not be verified");
}
function webpDimensions(buf) {
  const kind = buf.subarray(12, 16).toString("ascii");
  if (kind === "VP8X" && buf.length >= 30)
    return dimensions(1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
  if (kind === "VP8 " && buf.length >= 30)
    return dimensions(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
  if (kind === "VP8L" && buf.length >= 25) {
    const bits = buf.readUInt32LE(21); return dimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  fail("WebP dimensions could not be verified");
}
export function inspectSvg(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (!/<svg(?:\s|>)/i.test(text.slice(0, 4096))) fail("file is not an SVG document");
  const active = [
    { pattern: /<!doctype|<!entity/i, label: "DTD/entities" }, { pattern: /<script(?:\s|>)/i, label: "scripts" },
    { pattern: /<foreignObject(?:\s|>)/i, label: "foreignObject" }, { pattern: /\son[a-z]+\s*=/i, label: "event handlers" },
    { pattern: /(?:href|src)\s*=\s*["']?\s*(?:javascript:|file:|https?:|\/\/)/i, label: "external links" },
    { pattern: /url\(\s*["']?\s*(?:javascript:|file:|https?:|\/\/)/i, label: "external CSS URLs" },
  ];
  for (const { pattern, label } of active) if (pattern.test(text)) fail(`SVG ${label} are not allowed`);
  return { kind: "svg" };
}
export function inspectAsset(path, value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value), ext = String(path).toLowerCase().split(".").pop();
  if (ext === "svg") return inspectSvg(buf);
  if (ext === "png") {
    if (buf.length < 24 || !buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) fail("file extension says PNG but bytes do not");
    return { kind: "png", ...dimensions(buf.readUInt32BE(16), buf.readUInt32BE(20)) };
  }
  if (ext === "jpg" || ext === "jpeg") {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) fail("file extension says JPEG but bytes do not");
    return { kind: "jpeg", ...jpegDimensions(buf) };
  }
  if (ext === "webp") {
    if (buf.length < 30 || buf.subarray(0, 4).toString("ascii") !== "RIFF" || buf.subarray(8, 12).toString("ascii") !== "WEBP")
      fail("file extension says WebP but bytes do not");
    return { kind: "webp", ...webpDimensions(buf) };
  }
  if (ext === "ogg" && buf.subarray(0, 4).toString("ascii") !== "OggS") fail("file extension says Ogg but bytes do not");
  if (ext === "mp3" && !(buf.subarray(0, 3).toString("ascii") === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)))
    fail("file extension says MP3 but bytes do not");
  if (ext === "woff2" && buf.subarray(0, 4).toString("ascii") !== "wOF2") fail("file extension says WOFF2 but bytes do not");
  return { kind: ext };
}
