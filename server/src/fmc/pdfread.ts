/**
 * The built-in PDF reader (owner 27 Oct: "we need an inbuilt pdf parser"; "use hash tables to save data that is
 * occasionally referenced, to make it as fast as possible"). Mozilla's pdf.js reads the text (pdf.ts is the writer);
 * a PDF is read once:
 *
 * - path → {size, mtime, sha256}: an unchanged file is never hashed again;
 * - sha256 → the parsed document, in memory and in %APPDATA%\Formcraft\pdfcache\<sha256>.json, so the next session
 *   doesn't read it again either; a changed copy has a new sha256 and is read afresh;
 * - word → pages (the search index) and paragraph number → where it starts, built once with the document.
 *
 * Some gazette PDFs embed fonts whose codes are the letters shifted by 29 ("7LWOH" is "Title", code 3 is a space,
 * code 21 the digit 2). pdf.js passes those codes through when normalisation is off; a font is decoded when many of its
 * characters are control codes. Its small capitals sit at lowercase + 0xD19 and a few ligatures above 0x7F.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface PdfDoc {
  sha256: string; file: string; pages: string[]; shifted_fonts: number; read_at: string;
  /** word (lower case, 3+ letters or a number) → the pages it is on, 1-based */
  words: Record<string, number[]>;
  /** paragraph or regulation number → where each heading for it starts (contents list first, the body after) */
  paras: Record<string, Array<{ page: number; line: number }>>;
}

const LIG: Record<string, string> = { "¿": "fi", "À": "fl", "൵": "ff", "൶": "ffi", "൷": "ffl", "²": "—" };

/** One character of a shifted font, decoded. */
export function unshiftChar(c: string): string {
  if (LIG[c]) return LIG[c];
  const o = c.codePointAt(0)!;
  if (o >= 0xd7a && o <= 0xd93) return String.fromCodePoint(o - 0xd19);   // small capitals
  if (o >= 3 && o <= 97 && o !== 32) return String.fromCodePoint(o + 29);   // a real space stays a space
  return c;
}

/** A font is shifted when at least 5% of its characters are control codes (normal text has none). */
export function isShifted(stats: { chars: number; ctrl: number }): boolean {
  return stats.chars > 20 && stats.ctrl / stats.chars >= 0.05;
}

const WORD = /[a-z]{3,}|\d+(?:\.\d+)?/g;
const HEAD = /^\s*(\d{1,3}[A-Z]?)\.\s*\S/;

/** The search index and the paragraph index, built once from the pages' text. */
export function indexPages(pages: string[]): Pick<PdfDoc, "words" | "paras"> {
  const words = new Map<string, Set<number>>();
  const paras = new Map<string, Array<{ page: number; line: number }>>();
  pages.forEach((text, i) => {
    for (const w of text.toLowerCase().match(WORD) ?? []) {
      let s = words.get(w); if (!s) words.set(w, (s = new Set()));
      s.add(i + 1);
    }
    text.split("\n").forEach((l, j) => {
      const m = HEAD.exec(l);
      if (m && !/^\s*\d{1,3}\.\d/.test(l)) { const a = paras.get(m[1]) ?? []; a.push({ page: i + 1, line: j }); paras.set(m[1], a); }
    });
  });
  return { words: Object.fromEntries([...words].map(([w, s]) => [w, [...s]])), paras: Object.fromEntries(paras) };
}

/** Pages ranked by how many of the query's words they hold (all words first), each with its matching lines. */
export function findIn(doc: Pick<PdfDoc, "pages" | "words">, query: string, limit = 10) {
  const terms = [...new Set(query.toLowerCase().match(WORD) ?? [])];
  if (!terms.length) return [];
  const score = new Map<number, number>();
  for (const t of terms) for (const p of doc.words[t] ?? []) score.set(p, (score.get(p) ?? 0) + 1);
  return [...score].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit).map(([page, hits]) => ({
    page, hits, of: terms.length,
    lines: doc.pages[page - 1].split("\n").filter((l) => terms.some((t) => l.toLowerCase().includes(t))).slice(0, 6).map((l) => l.trim().slice(0, 240)),
  }));
}

/** A paragraph's text, from its heading to the next numbered heading (the body copy: its last heading). */
export function paragraph(doc: Pick<PdfDoc, "pages" | "paras">, n: string, maxChars = 6000): { para: string; page: number; text: string } | null {
  const at = doc.paras[n];
  if (!at?.length) return null;
  const { page, line } = at[at.length - 1];
  const out: string[] = [];
  for (let p = page; p <= doc.pages.length; p++) {
    const lines = doc.pages[p - 1].split("\n");
    for (let j = p === page ? line : 0; j < lines.length; j++) {
      if (out.length && HEAD.test(lines[j]) && !/^\s*\d{1,3}\.\d/.test(lines[j])) return { para: n, page, text: out.join("\n").slice(0, maxChars) };
      out.push(lines[j]);
      if (out.join("\n").length > maxChars) return { para: n, page, text: out.join("\n").slice(0, maxChars) };
    }
  }
  return { para: n, page, text: out.join("\n").slice(0, maxChars) };
}

// ---- reading and the caches ------------------------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
/** build/vendor/pdfjs (shipped with every build), else the checkout's node_modules. */
function pdfjsDir(): string {
  for (const d of [path.join(here, "..", "vendor", "pdfjs"), path.join(here, "..", "..", "node_modules", "pdfjs-dist", "legacy", "build")])
    if (fs.existsSync(path.join(d, "pdf.mjs"))) return d;
  throw new Error("pdf.js is missing from this build (build/vendor/pdfjs)");
}

const stamps = new Map<string, { stamp: string; sha256: string }>();
const docs = new Map<string, PdfDoc>();
const MAX_DOCS = 12;

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.APPDATA || path.join(env.USERPROFILE ?? ".", "AppData", "Roaming"), "Formcraft", "pdfcache");
}

/** The file's sha256, hashed only when its size or modified time changed since the last call. */
export function fingerprint(file: string): string {
  const s = fs.statSync(file);
  const stamp = `${s.size}:${s.mtimeMs}`;
  const hit = stamps.get(file);
  if (hit && hit.stamp === stamp) return hit.sha256;
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  stamps.set(file, { stamp, sha256 });
  return sha256;
}

async function extract(file: string): Promise<{ pages: string[]; shifted: number }> {
  const dir = pdfjsDir();
  const pdfjs: any = await import(pathToFileURL(path.join(dir, "pdf.mjs")).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(dir, "pdf.worker.mjs")).href;
  const vendor = path.basename(dir) === "pdfjs" ? dir : path.join(dir, "..", "..");
  // pdf.js wants these as forward-slash folders ending in "/"
  const cmaps = path.join(vendor, "cmaps").replace(/\\/g, "/") + "/", fonts = path.join(vendor, "standard_fonts").replace(/\\/g, "/") + "/";
  const task = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)), disableFontFace: true, isEvalSupported: false, verbosity: 0,
    ...(fs.existsSync(cmaps) ? { cMapUrl: cmaps, cMapPacked: true } : {}), ...(fs.existsSync(fonts) ? { standardFontDataUrl: fonts } : {}),
  });
  const doc = await task.promise;
  try {
    const raw: Array<Array<{ str: string; font: string; eol: boolean }>> = [];
    const stats = new Map<string, { chars: number; ctrl: number }>();
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent({ disableNormalization: true });
      raw.push(tc.items.filter((i: any) => typeof i.str === "string").map((i: any) => {
        const st = stats.get(i.fontName) ?? { chars: 0, ctrl: 0 };
        for (const c of i.str) { st.chars++; const o = c.codePointAt(0)!; if (o < 32 && o !== 10 && o !== 9) st.ctrl++; }
        stats.set(i.fontName, st);
        return { str: i.str, font: i.fontName, eol: !!i.hasEOL };
      }));
      page.cleanup();
    }
    const shifted = new Set([...stats].filter(([, s]) => isShifted(s)).map(([f]) => f));
    const pages = raw.map((items) => items.map((i) => (shifted.has(i.font) ? [...i.str].map(unshiftChar).join("") : i.str) + (i.eol ? "\n" : ""))
      .join("").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").replace(/[ \t]+\n/g, "\n"));
    return { pages, shifted: shifted.size };
  } finally {
    await task.destroy();
  }
}

/** The document, read at most once per content: memory, then the disk cache, then pdf.js. */
export async function readPdf(file: string, env: NodeJS.ProcessEnv = process.env): Promise<PdfDoc> {
  if (!/\.pdf$/i.test(file)) throw new Error("read_pdf reads .pdf files only");
  const sha256 = fingerprint(file);
  const mem = docs.get(sha256);
  if (mem) { docs.delete(sha256); docs.set(sha256, mem); return mem; }   // most recently used last
  const cached = path.join(cacheDir(env), `${sha256}.json`);
  let doc: PdfDoc | null = null;
  try { doc = JSON.parse(fs.readFileSync(cached, "utf8")); } catch { /* not read before */ }
  if (!doc) {
    const { pages, shifted } = await extract(file);
    doc = { sha256, file, pages, shifted_fonts: shifted, read_at: new Date().toISOString(), ...indexPages(pages) };
    try { fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.writeFileSync(cached, JSON.stringify(doc)); } catch { /* the cache is a speed-up only */ }
  }
  docs.set(sha256, doc);
  if (docs.size > MAX_DOCS) docs.delete(docs.keys().next().value!);
  return doc;
}
