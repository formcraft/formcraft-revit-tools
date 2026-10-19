/**
 * A small PDF writer without a library (like zip.ts and xlsx.ts): pages with lines, rectangles and text in the two
 * standard Helvetica faces (WinAnsi), uncompressed. Enough for the workshop pack (CW4): tables, labels and vector
 * nesting drawings. No images, no embedded fonts, no timestamps: the same pages always give the same bytes, so a
 * re-run of the pack sees "unchanged".
 *
 * Units are PDF points (1/72 inch); helpers convert from mm. The origin is the page's lower-left corner.
 */

export const MM = 72 / 25.4;
export const A4_LANDSCAPE: [number, number] = [842, 595];

// Advance widths (1/1000 em) for character codes 32–126, from the Adobe Helvetica and Helvetica-Bold AFM files.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// WinAnsiEncoding's 0x80–0x9F block, by Unicode code point.
const WIN_ANSI: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89,
  0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
// Characters WinAnsi lacks, spelled with ones it has.
const SPELL: Record<string, string> = { "≥": ">=", "≤": "<=", "→": "->", "←": "<-", "≈": "~", "✓": "v", "✗": "x", " ": " " };

/** Text as WinAnsi bytes; anything WinAnsi can't show becomes "?". */
export function winAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const spelled = SPELL[ch];
    if (spelled) { for (const c of spelled) out.push(c.charCodeAt(0)); continue; }
    const cp = ch.codePointAt(0)!;
    if (cp === 9) out.push(32);
    else if (cp >= 32 && cp < 127) out.push(cp);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else out.push(WIN_ANSI[cp] ?? 63);
  }
  return out;
}

/** Width of text in points at this size. */
export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELV_BOLD : HELV;
  let w = 0;
  for (const b of winAnsi(text)) w += b >= 32 && b <= 126 ? table[b - 32] : 556;
  return (w * size) / 1000;
}

/** Text cut to fit a width, with "…" when cut. */
export function fit(text: string, size: number, width: number, bold = false): string {
  if (textWidth(text, size, bold) <= width) return text;
  let t = text;
  while (t.length > 0 && textWidth(t + "…", size, bold) > width) t = t.slice(0, -1);
  return t.length ? t + "…" : "";
}

/** A PDF literal string: WinAnsi bytes, with the delimiters escaped and bytes above 126 as octal. */
function pdfString(text: string): string {
  let s = "(";
  for (const b of winAnsi(text)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += "\\" + String.fromCharCode(b);
    else if (b > 126) s += "\\" + b.toString(8).padStart(3, "0");
    else s += String.fromCharCode(b);
  }
  return s + ")";
}

const n = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

export interface TextOpts { size?: number; bold?: boolean; align?: "left" | "center" | "right"; gray?: number }

export class PdfPage {
  readonly ops: string[] = [];
  constructor(readonly width: number, readonly height: number) {}

  /** Stroke gray (0 black … 1 white) and line width for what follows. */
  stroke(gray = 0, width = 0.5): this { this.ops.push(`${n(gray)} G ${n(width)} w`); return this; }

  line(x1: number, y1: number, x2: number, y2: number): this { this.ops.push(`${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`); return this; }

  /** A rectangle: stroked, or filled with a gray and stroked. */
  rect(x: number, y: number, w: number, h: number, fill?: number): this {
    this.ops.push(fill === undefined ? `${n(x)} ${n(y)} ${n(w)} ${n(h)} re S` : `${n(fill)} g ${n(x)} ${n(y)} ${n(w)} ${n(h)} re B 0 g`);
    return this;
  }

  text(x: number, y: number, text: string, o: TextOpts = {}): this {
    const size = o.size ?? 9;
    const w = textWidth(text, size, o.bold);
    const x0 = o.align === "center" ? x - w / 2 : o.align === "right" ? x - w : x;
    const gray = o.gray ?? 0;
    this.ops.push(`BT ${n(gray)} g /${o.bold ? "F2" : "F1"} ${n(size)} Tf ${n(x0)} ${n(y)} Td ${pdfString(text)} Tj ET${gray ? " 0 g" : ""}`);
    return this;
  }

  /** Text turned 90° anticlockwise (reads upwards), starting at x, y. */
  textUp(x: number, y: number, text: string, o: TextOpts = {}): this {
    const size = o.size ?? 9;
    this.ops.push(`BT /${o.bold ? "F2" : "F1"} ${n(size)} Tf 0 1 -1 0 ${n(x)} ${n(y)} Tm ${pdfString(text)} Tj ET`);
    return this;
  }
}

export class PdfDoc {
  readonly pages: PdfPage[] = [];
  constructor(readonly title = "") {}

  page(size: [number, number] = A4_LANDSCAPE): PdfPage {
    const p = new PdfPage(size[0], size[1]);
    this.pages.push(p);
    return p;
  }

  /** The file: header, objects, cross-reference table and trailer; byte offsets are exact (latin1 throughout). */
  bytes(): Buffer {
    const objs: string[] = [];
    const add = (body: string) => { objs.push(body); return objs.length; };
    const catalog = add("");
    const pagesObj = add("");
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids: number[] = [];
    for (const p of this.pages) {
      const content = p.ops.join("\n");
      const c = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${n(p.width)} ${n(p.height)}] ` +
        `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    const info = add(`<< /Title ${pdfString(this.title)} /Producer (Formcraft Revit Tools) >>`);

    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets: number[] = [];
    objs.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}
