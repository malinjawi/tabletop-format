import { inflateRawSync, deflateRawSync } from "node:zlib";

const MAX_FILES = 4096;
const MAX_UNCOMPRESSED = 512 * 1024 * 1024;
const MAX_ENTRY = 128 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;

function u16(value) {
  const out = Buffer.alloc(2); out.writeUInt16LE(value); return out;
}

function u32(value) {
  const out = Buffer.alloc(4); out.writeUInt32LE(value >>> 0); return out;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeName(name) {
  if (typeof name !== "string" || !name || name.startsWith("/") || name.includes("\\"))
    throw new Error(`unsafe ZIP entry name: ${name}`);
  const parts = name.split("/");
  if (parts.some(part => !part || part === "." || part === ".."))
    throw new Error(`unsafe ZIP entry name: ${name}`);
  return name;
}

/** Build a byte-deterministic ZIP: sorted paths, fixed 1980 timestamp, deflate-9. */
export function deterministicZip(entries) {
  const normalized = entries instanceof Map ? [...entries] : [...entries];
  if (normalized.length > MAX_FILES) throw new Error(`ZIP has too many files (${normalized.length})`);
  const locals = [], directory = [];
  let offset = 0, total = 0;
  for (const [rawName, raw] of normalized.sort(([a], [b]) => a.localeCompare(b))) {
    const name = safeName(rawName), nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += data.length;
    if (total > MAX_UNCOMPRESSED) throw new Error("ZIP exceeds the 512 MiB uncompressed safety limit");
    const compressed = deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const local = Buffer.concat([
      Buffer.from("504b0304", "hex"), u16(20), u16(0x0800), u16(8), u16(0), u16(33),
      u32(crc), u32(compressed.length), u32(data.length), u16(nameBytes.length), u16(0),
      nameBytes, compressed,
    ]);
    locals.push(local);
    directory.push(Buffer.concat([
      Buffer.from("504b0102", "hex"), u16(20), u16(20), u16(0x0800), u16(8), u16(0), u16(33),
      u32(crc), u32(compressed.length), u32(data.length), u16(nameBytes.length), u16(0),
      u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(directory);
  return Buffer.concat([
    ...locals, central, Buffer.from("504b0506", "hex"), u16(0), u16(0),
    u16(normalized.length), u16(normalized.length), u32(central.length), u32(offset), u16(0),
  ]);
}

/** Read ordinary stored/deflated ZIPs into safe relative path -> Buffer entries. */
export function readZip(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a ZIP archive");
  const count = buffer.readUInt16LE(eocd + 10), centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count > MAX_FILES) throw new Error(`ZIP has too many files (${count})`);
  const entries = new Map(); let cursor = centralOffset, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor < 0 || cursor + 46 > buffer.length) throw new Error("invalid ZIP central directory bounds");
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid ZIP central directory");
    const method = buffer.readUInt16LE(cursor + 10), expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32), localOffset = buffer.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > buffer.length)
      throw new Error("invalid ZIP central directory entry bounds");
    const name = safeName(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
    if (entries.has(name)) throw new Error(`duplicate ZIP entry: ${name}`);
    if (size > MAX_ENTRY) throw new Error(`ZIP entry is larger than 128 MiB: ${name}`);
    total += size;
    if (total > MAX_UNCOMPRESSED) throw new Error("ZIP exceeds the 512 MiB uncompressed safety limit");
    if (compressedSize && size / compressedSize > MAX_COMPRESSION_RATIO)
      throw new Error(`ZIP entry compression ratio is unsafe: ${name}`);
    if (localOffset + 30 > buffer.length) throw new Error(`invalid local ZIP entry bounds: ${name}`);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`invalid local ZIP entry: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26), localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start < 0 || start + compressedSize > buffer.length) throw new Error(`invalid compressed ZIP data bounds: ${name}`);
    const compressed = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : null;
    if (!data) throw new Error(`unsupported ZIP compression method ${method}: ${name}`);
    if (data.length !== size || crc32(data) !== expectedCrc) throw new Error(`corrupt ZIP entry: ${name}`);
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
