import zlib from "node:zlib";

/**
 * The first worksheet of an .xlsx as rows of text, without a library: an .xlsx is a zip of XML parts. Enough for the
 * sheet register (shared strings, inline strings and numbers); formulas give their cached value. Read-only.
 */
export function readXlsx(buf: Buffer): string[][] {
  const files = unzip(buf);
  const shared: string[] = [];
  const sst = files.get("xl/sharedStrings.xml");
  if (sst) for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) ?? []) shared.push(text(si));
  const sheetName = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b))[0];
  const sheet = sheetName ? files.get(sheetName)! : "";
  const rows: string[][] = [];
  for (const row of sheet.match(/<row[\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = [];
    for (const c of row.match(/<c\b[^>]*?(\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const ref = /\br="([A-Z]+)\d+"/.exec(c)?.[1] ?? "";
      const type = /\bt="(\w+)"/.exec(c)?.[1] ?? "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1];
      const value = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? text(c) : unescape(v ?? "");
      const col = ref ? colIndex(ref) : cells.length;
      while (cells.length < col) cells.push("");
      cells[col] = value;
    }
    rows.push(cells);
  }
  return rows;
}

function num(name: string) { return Number(/sheet(\d+)/.exec(name)?.[1] ?? 0); }
function colIndex(ref: string) { let n = 0; for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function text(xml: string) { return (xml.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => unescape(t.replace(/<[^>]+>/g, ""))).join(""); }
function unescape(s: string) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** The zip's central directory; stored and deflated entries only (what Excel writes). */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("Not an .xlsx (zip) file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.endsWith(".xml")) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(name, (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8"));
  }
  return out;
}
