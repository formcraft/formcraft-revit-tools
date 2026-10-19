import zlib from "node:zlib";
import { writeZip } from "./zip.js";

/**
 * The first worksheet of an .xlsx as rows of text, without a library: an .xlsx is a zip of XML parts. Enough for the
 * sheet register (shared strings, inline strings and numbers); formulas give their cached value. writeXlsx (below)
 * writes the same subset: plain cell values, no formulas or dates.
 */
export function readXlsx(buf: Buffer): string[][] {
  const files = unzip(buf);
  const sheetName = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b))[0];
  return rowsOf(sheetName ? files.get(sheetName)! : "", sharedStrings(files));
}

/**
 * Every worksheet by its tab name (the kit's FMC_Revit_Kit.xlsx: View_Templates, Filters, Graphics…). With
 * rowNumbers, rows Excel left out (empty ones) come back as [] so rows[i] is the sheet's row i + 1.
 */
export function readXlsxSheets(buf: Buffer, opts: { rowNumbers?: boolean } = {}): Map<string, string[][]> {
  const files = unzip(buf);
  const shared = sharedStrings(files);
  const rels = new Map<string, string>();
  for (const r of files.get("xl/_rels/workbook.xml.rels")?.match(/<Relationship[^>]*>/g) ?? []) {
    const id = /Id="([^"]+)"/.exec(r)?.[1], target = /Target="([^"]+)"/.exec(r)?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }
  const out = new Map<string, string[][]>();
  for (const s of files.get("xl/workbook.xml")?.match(/<sheet[^>]*>/g) ?? []) {
    const name = unescape(/name="([^"]*)"/.exec(s)?.[1] ?? "");
    const rid = /r:id="([^"]+)"/.exec(s)?.[1] ?? "";
    const part = rels.get(rid);
    if (name && part) out.set(name, rowsOf(files.get("xl/" + part) ?? "", shared, opts.rowNumbers));
  }
  return out;
}

function sharedStrings(files: Map<string, string>): string[] {
  const shared: string[] = [];
  const sst = files.get("xl/sharedStrings.xml");
  if (sst) for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) ?? []) shared.push(text(si));
  return shared;
}

function rowsOf(sheet: string, shared: string[], rowNumbers = false): string[][] {
  const rows: string[][] = [];
  // A row with no cells can be written <row r="5"/>: it must not swallow the next row.
  for (const row of sheet.match(/<row\b[^>]*?(\/>|>[\s\S]*?<\/row>)/g) ?? []) {
    if (rowNumbers) {
      const r = Number(/^<row\b[^>]*?\br="(\d+)"/.exec(row)?.[1] ?? 0);
      while (r && rows.length < r - 1) rows.push([]);
    }
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
  // Character references too: Excel writes "–" as &#8211; in some files (the kit's FMC_Revit_Kit.xlsx).
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
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
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(name, (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8"));
  }
  return out;
}

// ---------- writing ----------

export type XlsxCell = string | number | boolean | null | undefined;
export interface XlsxSheet {
  name: string;
  rows: XlsxCell[][];
  /** Bold first row, frozen, with a filter (a table people edit). */
  header?: boolean;
}

/** Why a tab name won't do in Excel (31 characters, none of []:*?/\), or "". */
export function sheetNameProblem(name: string): string {
  if (!name.trim()) return "A sheet needs a name";
  if (name.length > 31) return `Sheet name "${name}" is longer than Excel's 31 characters`;
  if (/[[\]:*?/\\]/.test(name)) return `Sheet name "${name}" has a character Excel doesn't allow ([ ] : * ? / \\)`;
  return "";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  // characters XML 1.0 can't carry at all
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/**
 * An .xlsx of plain cell values: text (shared strings), numbers and booleans; null and "" leave the cell empty. No
 * formulas, dates or merged cells: what a person needs to edit a kit table, and what readXlsxSheets reads back.
 */
export function writeXlsx(sheets: XlsxSheet[], when = new Date()): Buffer {
  if (!sheets.length) throw new Error("An .xlsx needs at least one sheet");
  const seen = new Set<string>();
  for (const s of sheets) {
    const p = sheetNameProblem(s.name);
    if (p) throw new Error(p);
    if (seen.has(s.name.toLowerCase())) throw new Error(`Two sheets are called "${s.name}"`);
    seen.add(s.name.toLowerCase());
  }
  const strings: string[] = [];
  const index = new Map<string, number>();
  const si = (s: string) => {
    let i = index.get(s);
    if (i === undefined) { i = strings.length; strings.push(s); index.set(s, i); }
    return i;
  };
  const sheetXml = (s: XlsxSheet) => {
    const width = Math.max(0, ...s.rows.map((r) => r.length));
    const cols = Array.from({ length: width }, (_, c) => {
      const longest = Math.max(4, ...s.rows.slice(0, 200).map((r) => String(r[c] ?? "").split("\n")[0].length));
      return `<col min="${c + 1}" max="${c + 1}" width="${Math.min(60, longest + 2)}" customWidth="1"/>`;
    }).join("");
    const rows = s.rows.map((r, ri) => {
      const cells = r.map((v, ci) => {
        const ref = colName(ci) + (ri + 1);
        const style = s.header && ri === 0 ? ' s="1"' : "";
        if (v === null || v === undefined || v === "") return "";
        if (typeof v === "number") return Number.isFinite(v) ? `<c r="${ref}"${style}><v>${v}</v></c>` : `<c r="${ref}"${style} t="s"><v>${si(String(v))}</v></c>`;
        if (typeof v === "boolean") return `<c r="${ref}"${style} t="b"><v>${v ? 1 : 0}</v></c>`;
        return `<c r="${ref}"${style} t="s"><v>${si(v)}</v></c>`;
      }).join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join("");
    const freeze = s.header && s.rows.length
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    const filter = s.header && s.rows.length && width ? `<autoFilter ref="A1:${colName(width - 1)}${s.rows.length}"/>` : "";
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      freeze + (cols ? `<cols>${cols}</cols>` : "") + `<sheetData>${rows}</sheetData>${filter}</worksheet>`;
  };
  const sheetParts = sheets.map(sheetXml);
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
  const files: Array<{ name: string; data: string }> = [
    { name: "[Content_Types].xml", data: head +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '</Types>' },
    { name: "_rels/.rels", data: head +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '</Relationships>' },
    { name: "docProps/core.xml", data: head +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:creator>Formcraft</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${when.toISOString().replace(/\.\d{3}Z$/, "Z")}</dcterms:created>` +
      '</cp:coreProperties>' },
    { name: "xl/workbook.xml", data: head +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + '</sheets></workbook>' },
    { name: "xl/_rels/workbook.xml.rels", data: head +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
      '</Relationships>' },
    { name: "xl/styles.xml", data: head +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>' },
    ...sheetParts.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
  ];
  // The shared strings last: every sheet has added its text by now.
  files.push({ name: "xl/sharedStrings.xml", data: head +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
    strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("") + '</sst>' });
  return writeZip(files, when);
}
