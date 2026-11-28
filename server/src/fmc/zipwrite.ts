/**
 * A streaming zip writer (PKWARE APPNOTE 6.3, no Zip64) for the handover package. fmc/zip.ts builds a zip in memory
 * (BCF, small packages); this one writes to disk so a model file of hundreds of MB is never held in memory. Buffers are deflated when that is
 * smaller; files are stored and streamed in 1 MB chunks, so a model file is never held in memory. Each entry's CRC-32
 * and SHA-256 are computed while it is written. Nothing here reads a model: callers pass the files to add.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";

const CHUNK = 1024 * 1024;
/** Without Zip64 every size and offset must stay under 4 GiB. */
export const ZIP_MAX_BYTES = 0xffffffff - 1024 * 1024;

let table: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC-32 (IEEE), continued from crc when given. */
export function crc32(data: Uint8Array, crc = 0): number {
  const t = crcTable();
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ZipSource = { name: string; data: Buffer } | { name: string; file: string };

export interface ZipEntryResult {
  name: string;
  bytes: number;
  compressed: number;
  crc32: string;
  sha256: string;
  method: "store" | "deflate";
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  };
}

/** A safe entry name: forward slashes, no drive, no "..", no leading slash. */
export function zipEntryName(name: string): string {
  const parts = name.replace(/\\/g, "/").split("/").filter((p) => p && p !== "." && p !== "..");
  const clean = parts.map((p) => p.replace(/[<>:"|?*\u0000-\u001f]/g, "_")).join("/");
  if (!clean) throw new Error(`Zip entry name "${name}" is empty after cleaning`);
  return clean;
}

function header(sig: number, size: number): Buffer {
  const b = Buffer.alloc(size);
  b.writeUInt32LE(sig, 0);
  return b;
}

/** Hash and CRC a file by streaming it once. */
function scanFile(file: string): { size: number; crc: number; sha256: string } {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    const hash = crypto.createHash("sha256");
    let crc = 0;
    let size = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      const part = buf.subarray(0, n);
      crc = crc32(part, crc);
      hash.update(part);
      size += n;
    }
    return { size, crc, sha256: hash.digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Writes the entries to target. The zip is written as target + ".partial" and renamed at the end, so a failed write
 * never leaves a zip that looks complete. Refuses to overwrite an existing target.
 */
export function writeZip(
  target: string,
  sources: ZipSource[],
  now: Date = new Date(),
  tail?: (written: ZipEntryResult[]) => ZipSource[],
): { bytes: number; sha256: string; entries: ZipEntryResult[] } {
  if (fs.existsSync(target)) throw new Error(`[FMC-HANDOVER-EXISTS] ${target} already exists. Nothing is overwritten.`);
  const partial = `${target}.partial`;
  const { time, date } = dosTime(now);
  const fd = fs.openSync(partial, "wx");
  const central: Buffer[] = [];
  const results: ZipEntryResult[] = [];
  const seen = new Set<string>();
  let offset = 0;
  const put = (b: Buffer) => {
    fs.writeSync(fd, b, 0, b.length, null);
    offset += b.length;
    if (offset > ZIP_MAX_BYTES) throw new Error("[FMC-HANDOVER-TOO-BIG] The zip would pass 4 GB. Zip64 is not supported; leave the model out or split the package.");
  };
  try {
    const addAll = (list: ZipSource[]) => { for (const src of list) addOne(src); };
    const addOne = (src: ZipSource) => {
      const name = zipEntryName(src.name);
      if (seen.has(name.toLowerCase())) throw new Error(`[FMC-HANDOVER-DUPLICATE] Two entries are named ${name}`);
      seen.add(name.toLowerCase());
      const nameBuf = Buffer.from(name, "utf8");
      let crc: number;
      let size: number;
      let sha: string;
      let method: 0 | 8 = 0;
      let payload: Buffer | null = null;
      if ("data" in src) {
        crc = crc32(src.data);
        size = src.data.length;
        sha = crypto.createHash("sha256").update(src.data).digest("hex");
        const deflated = zlib.deflateRawSync(src.data, { level: 6 });
        if (deflated.length < src.data.length) { method = 8; payload = deflated; } else payload = src.data;
      } else {
        const scan = scanFile(src.file);
        crc = scan.crc;
        size = scan.size;
        sha = scan.sha256;
      }
      const compressed = payload ? payload.length : size;
      if (size > ZIP_MAX_BYTES || compressed > ZIP_MAX_BYTES) throw new Error(`[FMC-HANDOVER-TOO-BIG] ${name} is over 4 GB. Zip64 is not supported.`);
      const localOffset = offset;
      const local = header(0x04034b50, 30);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      put(local);
      put(nameBuf);
      if (payload) put(payload);
      else {
        const rd = fs.openSync((src as { file: string }).file, "r");
        try {
          const buf = Buffer.alloc(CHUNK);
          let copied = 0;
          for (;;) {
            const n = fs.readSync(rd, buf, 0, CHUNK, null);
            if (n <= 0) break;
            put(buf.subarray(0, n));
            copied += n;
          }
          if (copied !== size) throw new Error(`[FMC-HANDOVER-CHANGED] ${name} changed while it was being zipped. Nothing was kept.`);
        } finally {
          fs.closeSync(rd);
        }
      }
      const cd = header(0x02014b50, 46);
      cd.writeUInt16LE(0x033f, 4); // made by: version 6.3
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(method, 10);
      cd.writeUInt16LE(time, 12);
      cd.writeUInt16LE(date, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(compressed, 20);
      cd.writeUInt32LE(size, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt32LE(localOffset, 42);
      central.push(Buffer.concat([cd, nameBuf]));
      results.push({ name, bytes: size, compressed, crc32: crc.toString(16).padStart(8, "0"), sha256: sha, method: method === 8 ? "deflate" : "store" });
    };
    addAll(sources);
    if (tail) addAll(tail(results.slice()));
    const cdStart = offset;
    for (const c of central) put(c);
    const cdSize = offset - cdStart;
    if (results.length > 0xffff) throw new Error("[FMC-HANDOVER-TOO-BIG] More than 65535 entries.");
    const end = header(0x06054b50, 22);
    end.writeUInt16LE(results.length, 8);
    end.writeUInt16LE(results.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    put(end);
    fs.closeSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(partial); } catch { /* our own partial file only */ }
    throw error;
  }
  fs.renameSync(partial, target);
  const whole = scanFile(target);
  return { bytes: whole.size, sha256: whole.sha256, entries: results };
}

/** Reads a zip written by writeZip into memory (tests and small packages): names, sizes and whether every CRC matches. */
export function readZip(file: string): Array<{ name: string; bytes: number; crcOk: boolean; data: Buffer }> {
  const all = fs.readFileSync(file);
  let eocd = -1;
  for (let i = all.length - 22; i >= Math.max(0, all.length - 22 - 0xffff); i--) {
    if (all.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip: no end of central directory");
  const count = all.readUInt16LE(eocd + 10);
  let p = all.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; bytes: number; crcOk: boolean; data: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    if (all.readUInt32LE(p) !== 0x02014b50) throw new Error("Bad central directory");
    const method = all.readUInt16LE(p + 10);
    const crc = all.readUInt32LE(p + 16);
    const csize = all.readUInt32LE(p + 20);
    const size = all.readUInt32LE(p + 24);
    const nlen = all.readUInt16LE(p + 28);
    const xlen = all.readUInt16LE(p + 30);
    const clen = all.readUInt16LE(p + 32);
    const local = all.readUInt32LE(p + 42);
    const name = all.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = all.readUInt16LE(local + 26);
    const lxlen = all.readUInt16LE(local + 28);
    const start = local + 30 + lnlen + lxlen;
    const raw = all.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    out.push({ name, bytes: size, crcOk: crc32(data) === crc && data.length === size, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
