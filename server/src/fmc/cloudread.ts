/**
 * Minimal point cloud readers for fmc_pointcloud: LAS 1.0-1.4 (uncompressed, any point format) and ASTM E57
 * (cartesian or spherical points; Float, Integer or ScaledInteger fields; the scan pose applied). Written here, no new
 * dependency. LAZ (LASzip-compressed LAS) is detected and refused with a clear code: decompress it to LAS first.
 * Points are sampled by stride to at most maxPoints, so a large scan is streamed, never held whole in memory.
 */
import fs from "node:fs";

export interface CloudRead {
  format: "las" | "e57";
  file: string;
  total: number;
  sampled: number;
  stride: number;
  /** x, y, z in the file's units, after the E57 pose */
  points: Float64Array;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  scans: number;
  notes: string[];
  version: string;
}

export class CloudError extends Error {
  constructor(public code: string, message: string) { super(`[${code}] ${message}`); }
}

const CHUNK = 1 << 20;

/** Reads bytes at any offset with a 1 MB window, so a scan of many GB is read in order without loading it. */
class FileWindow {
  private fd: number;
  private buf = Buffer.alloc(CHUNK);
  private start = -1;
  private len = 0;
  readonly size: number;
  constructor(file: string) {
    this.fd = fs.openSync(file, "r");
    this.size = fs.fstatSync(this.fd).size;
  }
  close() { try { fs.closeSync(this.fd); } catch { /* closed */ } }
  /** Copies n bytes at offset into out. */
  read(offset: number, n: number, out: Buffer = Buffer.alloc(n), at = 0): Buffer {
    if (offset < 0 || offset + n > this.size) throw new CloudError("FMC-POINTCLOUD-READ", `Read past the end of the file at ${offset}`);
    let done = 0;
    while (done < n) {
      const pos = offset + done;
      if (this.start < 0 || pos < this.start || pos >= this.start + this.len) {
        this.start = pos;
        this.len = fs.readSync(this.fd, this.buf, 0, CHUNK, pos);
        if (this.len <= 0) throw new CloudError("FMC-POINTCLOUD-READ", `Could not read at ${pos}`);
      }
      const from = pos - this.start;
      const take = Math.min(n - done, this.len - from);
      this.buf.copy(out, at + done, from, from + take);
      done += take;
    }
    return out;
  }
}

export function detectFormat(file: string): "las" | "laz" | "e57" | "unknown" {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(120);
    const n = fs.readSync(fd, head, 0, 120, 0);
    if (n >= 8 && head.toString("latin1", 0, 8) === "ASTM-E57") return "e57";
    if (n >= 4 && head.toString("latin1", 0, 4) === "LASF") {
      const fmt = n > 104 ? head.readUInt8(104) : 0;
      if ((fmt & 0xc0) !== 0 || /\.laz$/i.test(file)) return "laz";
      return "las";
    }
    return "unknown";
  } finally {
    fs.closeSync(fd);
  }
}

function emptyBounds() { return { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] }; }
function grow(b: ReturnType<typeof emptyBounds>, x: number, y: number, z: number) {
  if (x < b.min[0]) b.min[0] = x; if (y < b.min[1]) b.min[1] = y; if (z < b.min[2]) b.min[2] = z;
  if (x > b.max[0]) b.max[0] = x; if (y > b.max[1]) b.max[1] = y; if (z > b.max[2]) b.max[2] = z;
}

export function readCloud(file: string, opts: { maxPoints: number }): CloudRead {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new CloudError("FMC-POINTCLOUD-FILE", `Point cloud file not found: ${file}`);
  const kind = detectFormat(file);
  if (kind === "laz") throw new CloudError("FMC-POINTCLOUD-LAZ", "This is LAZ (LASzip-compressed). This build reads LAS and E57. Decompress it to LAS first, for example `pdal translate in.laz out.las` or `laszip -i in.laz -o out.las`, then run again.");
  if (kind === "las") return readLas(file, opts.maxPoints);
  if (kind === "e57") return readE57(file, opts.maxPoints);
  throw new CloudError("FMC-POINTCLOUD-FORMAT", "Not an E57 or LAS file (the first bytes are neither ASTM-E57 nor LASF).");
}

// ---------------------------------------------------------------- LAS

export function readLas(file: string, maxPoints: number): CloudRead {
  const w = new FileWindow(file);
  try {
    const h = w.read(0, Math.min(375, w.size));
    const major = h.readUInt8(24);
    const minor = h.readUInt8(25);
    const offset = h.readUInt32LE(96);
    const fmt = h.readUInt8(104);
    const recLen = h.readUInt16LE(105);
    let count = h.readUInt32LE(107);
    if (major === 1 && minor >= 4 && h.length >= 255) {
      const big = Number(h.readBigUInt64LE(247));
      if (big > 0) count = big;
    }
    const sx = h.readDoubleLE(131), sy = h.readDoubleLE(139), sz = h.readDoubleLE(147);
    const ox = h.readDoubleLE(155), oy = h.readDoubleLE(163), oz = h.readDoubleLE(171);
    if (recLen < 12) throw new CloudError("FMC-POINTCLOUD-FORMAT", `LAS point record length ${recLen} is too short`);
    const available = Math.floor((w.size - offset) / recLen);
    if (available < count) count = available;
    const stride = Math.max(1, Math.ceil(count / Math.max(1, maxPoints)));
    const keep = Math.ceil(count / stride);
    const pts = new Float64Array(keep * 3);
    const b = emptyBounds();
    const rec = Buffer.alloc(12);
    let k = 0;
    for (let i = 0; i < count && k < keep; i += stride) {
      w.read(offset + i * recLen, 12, rec);
      const x = rec.readInt32LE(0) * sx + ox, y = rec.readInt32LE(4) * sy + oy, z = rec.readInt32LE(8) * sz + oz;
      pts[k * 3] = x; pts[k * 3 + 1] = y; pts[k * 3 + 2] = z;
      grow(b, x, y, z);
      k++;
    }
    return {
      format: "las", file, total: count, sampled: k, stride, points: pts.subarray(0, k * 3), bounds: k ? b : null, scans: 1,
      notes: [`LAS ${major}.${minor}, point format ${fmt}, ${recLen}-byte records`], version: `${major}.${minor}`,
    };
  } finally {
    w.close();
  }
}

// ---------------------------------------------------------------- E57

export interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string }

/** A small XML parser for the E57 section: elements, attributes, text and CDATA. Comments and declarations are skipped. */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, "&");
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1].text += decode(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith("<![CDATA[", lt)) { const e = src.indexOf("]]>", lt); stack[stack.length - 1].text += src.slice(lt + 9, e < 0 ? src.length : e); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith("<?", lt) || src.startsWith("<!", lt)) { const e = src.indexOf(">", lt); i = e < 0 ? src.length : e + 1; continue; }
    const gt = src.indexOf(">", lt);
    if (gt < 0) break;
    const body = src.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith("/")) { if (stack.length > 1) stack.pop(); continue; }
    const selfClose = body.endsWith("/");
    const inner = selfClose ? body.slice(0, -1) : body;
    const m = /^([^\s/]+)/.exec(inner);
    if (!m) continue;
    const node: XmlNode = { name: m[1], attrs: {}, children: [], text: "" };
    for (const a of inner.slice(m[1].length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) node.attrs[a[1]] = decode(a[3] ?? a[4] ?? "");
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

const child = (n: XmlNode | undefined, name: string) => n?.children.find((c) => c.name === name);
const num = (n: XmlNode | undefined, fallback = 0) => {
  if (!n) return fallback;
  const v = Number(n.text.trim());
  return n.text.trim() === "" || !Number.isFinite(v) ? fallback : v;
};

export interface E57Field {
  name: string;
  type: "Float" | "Integer" | "ScaledInteger";
  precision: "single" | "double";
  min: number;
  max: number;
  scale: number;
  offset: number;
  bits: number;
}

export function e57Field(n: XmlNode): E57Field {
  const type = (n.attrs.type ?? "Float") as E57Field["type"];
  const precision = n.attrs.precision === "single" ? "single" : "double";
  const min = Number(n.attrs.minimum ?? (type === "Float" ? -Infinity : -(2 ** 53)));
  const max = Number(n.attrs.maximum ?? (type === "Float" ? Infinity : 2 ** 53));
  const scale = Number(n.attrs.scale ?? 1);
  const offset = Number(n.attrs.offset ?? 0);
  let bits = 0;
  if (type !== "Float") {
    const range = max - min;
    bits = range <= 0 ? 0 : Math.ceil(Math.log2(range + 1));
    if (bits > 53) throw new CloudError("FMC-POINTCLOUD-E57", `${n.name}: integer fields wider than 53 bits are not supported`);
  } else bits = precision === "single" ? 32 : 64;
  return { name: n.name, type, precision, min, max, scale, offset, bits };
}

/** Logical E57 bytes: every 1024-byte page ends with a 4-byte CRC that is not data. */
class E57Logical {
  constructor(private w: FileWindow, private page = 1024) {}
  private get data() { return this.page - 4; }
  physToLog(phys: number) { return Math.floor(phys / this.page) * this.data + (phys % this.page); }
  read(logical: number, n: number): Buffer {
    const out = Buffer.alloc(n);
    let done = 0;
    while (done < n) {
      const l = logical + done;
      const pageNo = Math.floor(l / this.data);
      const inPage = l % this.data;
      const take = Math.min(n - done, this.data - inPage);
      this.w.read(pageNo * this.page + inPage, take, out, done);
      done += take;
    }
    return out;
  }
}

/** A continuous little-endian, least-significant-bit-first bit stream for one field, fed one packet buffer at a time. */
class BitStream {
  private bytes: Buffer[] = [];
  private cur: Buffer = Buffer.alloc(0);
  private pos = 0; // bit position in cur
  push(b: Buffer) { if (b.length) this.bytes.push(b); }
  availableBits(): number {
    let n = this.cur.length * 8 - this.pos;
    for (const b of this.bytes) n += b.length * 8;
    return n;
  }
  private byteAt(): number {
    while (this.pos >= this.cur.length * 8) {
      const next = this.bytes.shift();
      if (!next) throw new Error("bit stream empty");
      this.cur = next;
      this.pos = 0;
    }
    return this.cur[this.pos >> 3];
  }
  readBits(bits: number): number {
    let value = 0;
    let got = 0;
    while (got < bits) {
      const byte = this.byteAt();
      const off = this.pos & 7;
      const take = Math.min(8 - off, bits - got);
      const part = (byte >> off) & ((1 << take) - 1);
      value += part * 2 ** got;
      got += take;
      this.pos += take;
    }
    return value;
  }
  readBytes(n: number): Buffer {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) out[i] = this.readBits(8);
    return out;
  }
}

interface Scan {
  name: string;
  fileOffset: number;
  recordCount: number;
  fields: E57Field[];
  rotation: [number, number, number, number]; // w x y z
  translation: [number, number, number];
}

function scansOf(root: XmlNode): Scan[] {
  const e57 = child(root, "e57Root");
  const data3D = child(e57, "data3D");
  const out: Scan[] = [];
  for (const v of data3D?.children ?? []) {
    const points = child(v, "points");
    if (!points || points.attrs.type !== "CompressedVector") continue;
    const proto = child(points, "prototype");
    const fields = (proto?.children ?? []).map(e57Field);
    const pose = child(v, "pose");
    const rot = child(pose, "rotation");
    const tr = child(pose, "translation");
    out.push({
      name: child(v, "name")?.text.trim() ?? "",
      fileOffset: Number(points.attrs.fileOffset ?? 0),
      recordCount: Number(points.attrs.recordCount ?? 0),
      fields,
      rotation: rot ? [num(child(rot, "w"), 1), num(child(rot, "x")), num(child(rot, "y")), num(child(rot, "z"))] : [1, 0, 0, 0],
      translation: tr ? [num(child(tr, "x")), num(child(tr, "y")), num(child(tr, "z"))] : [0, 0, 0],
    });
  }
  return out;
}

function decodeValue(f: E57Field, s: BitStream): number {
  if (f.type === "Float") {
    const b = s.readBytes(f.precision === "single" ? 4 : 8);
    return f.precision === "single" ? b.readFloatLE(0) : b.readDoubleLE(0);
  }
  const raw = f.bits ? s.readBits(f.bits) : 0;
  const v = f.min + raw;
  return f.type === "ScaledInteger" ? v * f.scale + f.offset : v;
}

function hasValue(f: E57Field, s: BitStream): boolean {
  return f.bits === 0 || s.availableBits() >= f.bits;
}

export function readE57(file: string, maxPoints: number): CloudRead {
  const w = new FileWindow(file);
  try {
    const h = w.read(0, 48);
    const major = h.readUInt32LE(8), minor = h.readUInt32LE(12);
    const xmlPhys = Number(h.readBigUInt64LE(24));
    const xmlLen = Number(h.readBigUInt64LE(32));
    const pageSize = Number(h.readBigUInt64LE(40)) || 1024;
    const log = new E57Logical(w, pageSize);
    const xml = log.read(log.physToLog(xmlPhys), xmlLen).toString("utf8");
    const scans = scansOf(parseXml(xml));
    if (!scans.length) throw new CloudError("FMC-POINTCLOUD-E57", "The E57 file has no data3D scans with points.");
    const total = scans.reduce((n, s) => n + s.recordCount, 0);
    const stride = Math.max(1, Math.ceil(total / Math.max(1, maxPoints)));
    const keep = Math.ceil(total / stride) + scans.length;
    const pts = new Float64Array(keep * 3);
    const b = emptyBounds();
    const notes: string[] = [`E57 ${major}.${minor}, ${scans.length} scan(s)`];
    let k = 0;
    let global = 0;
    for (const scan of scans) {
      const names = scan.fields.map((f) => f.name);
      const cart = ["cartesianX", "cartesianY", "cartesianZ"].every((n) => names.includes(n));
      const sph = ["sphericalRange", "sphericalAzimuth", "sphericalElevation"].every((n) => names.includes(n));
      if (!cart && !sph) { notes.push(`scan "${scan.name}": no cartesian or spherical coordinates, skipped`); global += scan.recordCount; continue; }
      const want = cart ? ["cartesianX", "cartesianY", "cartesianZ"] : ["sphericalRange", "sphericalAzimuth", "sphericalElevation"];
      const invalidName = cart ? "cartesianInvalidState" : "sphericalInvalidState";
      const needIdx = want.map((n) => names.indexOf(n));
      const invIdx = names.indexOf(invalidName);
      const streams = scan.fields.map(() => new BitStream());
      const used = new Set([...needIdx, ...(invIdx >= 0 ? [invIdx] : [])]);
      const [qw, qx, qy, qz] = scan.rotation;
      const [tx, ty, tz] = scan.translation;
      // rotation matrix of the unit quaternion
      const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qz * qw), r02 = 2 * (qx * qz + qy * qw);
      const r10 = 2 * (qx * qy + qz * qw), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qx * qw);
      const r20 = 2 * (qx * qz - qy * qw), r21 = 2 * (qy * qz + qx * qw), r22 = 1 - 2 * (qx * qx + qy * qy);
      // section header
      const secLog = log.physToLog(scan.fileOffset);
      const sec = log.read(secLog, 32);
      if (sec.readUInt8(0) !== 1) throw new CloudError("FMC-POINTCLOUD-E57", `scan "${scan.name}": not a compressed vector section`);
      const secLen = Number(sec.readBigUInt64LE(8));
      const dataPhys = Number(sec.readBigUInt64LE(16));
      let p = log.physToLog(dataPhys);
      const end = secLog + secLen;
      let done = 0;
      let invalid = 0;
      while (done < scan.recordCount && p < end) {
        const ph = log.read(p, 6);
        const type = ph.readUInt8(0);
        const plen = ph.readUInt16LE(2) + 1;
        if (type === 1) {
          const count = ph.readUInt16LE(4);
          const lens = log.read(p + 6, count * 2);
          let at = p + 6 + count * 2;
          for (let s = 0; s < count; s++) {
            const len = lens.readUInt16LE(s * 2);
            if (used.has(s) && len) streams[s].push(log.read(at, len));
            at += len;
          }
          for (;;) {
            if (done >= scan.recordCount) break;
            if (!needIdx.every((ix) => hasValue(scan.fields[ix], streams[ix]))) break;
            if (invIdx >= 0 && !hasValue(scan.fields[invIdx], streams[invIdx])) break;
            const a = decodeValue(scan.fields[needIdx[0]], streams[needIdx[0]]);
            const c = decodeValue(scan.fields[needIdx[1]], streams[needIdx[1]]);
            const d = decodeValue(scan.fields[needIdx[2]], streams[needIdx[2]]);
            const bad = invIdx >= 0 ? decodeValue(scan.fields[invIdx], streams[invIdx]) !== 0 : false;
            if (global % stride === 0 && k < keep) {
              if (bad) invalid++;
              else {
                let x = a, y = c, z = d;
                if (!cart) { const ce = Math.cos(d); x = a * ce * Math.cos(c); y = a * ce * Math.sin(c); z = a * Math.sin(d); }
                const X = r00 * x + r01 * y + r02 * z + tx, Y = r10 * x + r11 * y + r12 * z + ty, Z = r20 * x + r21 * y + r22 * z + tz;
                pts[k * 3] = X; pts[k * 3 + 1] = Y; pts[k * 3 + 2] = Z;
                grow(b, X, Y, Z);
                k++;
              }
            }
            done++;
            global++;
          }
        }
        p += plen;
      }
      if (done < scan.recordCount) { notes.push(`scan "${scan.name}": ${scan.recordCount - done} records could not be read`); global += scan.recordCount - done; }
      if (invalid) notes.push(`scan "${scan.name}": ${invalid} sampled points marked invalid, left out`);
      if (!cart) notes.push(`scan "${scan.name}": spherical coordinates converted to cartesian`);
    }
    return { format: "e57", file, total, sampled: k, stride, points: pts.subarray(0, k * 3), bounds: k ? b : null, scans: scans.length, notes, version: `${major}.${minor}` };
  } finally {
    w.close();
  }
}
