/**
 * Formcraft's built-in web reader (owner 27 Oct: collect standards and manufacturers' catalogues for families). Reads
 * a page as text, lists its links and downloadable files (PDF catalogues, RFA/IFC/DWG models), and tells when a page
 * changed since it was last read (new editions, amended laws, new products). Polite by design: robots.txt is obeyed,
 * one request per host every few seconds, a named agent, no cookies, no logins and nothing behind a paywall. Pages are
 * kept in a cache by URL (%APPDATA%\Formcraft\webcache), so a page read today is answered from disk.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Formcraft-web-reader/1.0 (+standards and product catalogues)";
const FILE_KINDS: Record<string, string> = { pdf: "pdf", rfa: "rfa", rvt: "rvt", ifc: "ifc", dwg: "dwg", dxf: "dxf", zip: "zip", xlsx: "xlsx", xls: "xls", csv: "csv", docx: "docx", skp: "skp", "3ds": "3ds", obj: "obj" };

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", deg: "°", sup2: "²", sup3: "³", times: "×", frac12: "½", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", copy: "©", reg: "®", trade: "™", middot: "·", plusmn: "±", le: "≤", ge: "≥" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}

/** Readable text from HTML: scripts, styles and menus out; headings, paragraphs, list items and table rows on their own lines. */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<(nav|footer)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<h([1-6])[^>]*>/gi, (_m, n) => `\n${"#".repeat(Number(n))} `).replace(/<li[^>]*>/gi, "\n- ").replace(/<(td|th)[^>]*>/gi, " | ");
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|section|article|header|h[1-6]|li|tr|table|ul|ol|dl|dt|dd|blockquote|pre)>/gi, "\n");
  s = decodeEntities(s.replace(/<[^>]+>/g, " "));
  return s.split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter((l, i, a) => l || (a[i - 1] ?? "") !== "").join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function titleOf(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
}

export interface WebLink { url: string; text: string; kind: string; same_site: boolean }
/** Every link on the page, absolute, once each, with its file kind (pdf, rfa, ifc, dwg, zip...) or "page". */
export function extractLinks(html: string, base: string): WebLink[] {
  const seen = new Set<string>(), out: WebLink[] = [], host = new URL(base).host;
  const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    if (!raw || /^(javascript|mailto|tel|data):/i.test(raw) || raw.startsWith("#")) continue;
    let u: URL; try { u = new URL(raw, base); } catch { continue; }
    u.hash = ""; const url = u.toString();
    if (seen.has(url)) continue; seen.add(url);
    const ext = (/\.([a-z0-9]{2,4})$/i.exec(u.pathname)?.[1] ?? "").toLowerCase();
    out.push({ url, text: decodeEntities(m[4].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 160), kind: FILE_KINDS[ext] ?? "page", same_site: u.host === host });
  }
  return out;
}

/** robots.txt for our agent: the group for "formcraft" if any, else "*"; the longest matching Allow/Disallow wins. */
export function robotsAllows(robots: string, pathAndQuery: string): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let cur: (typeof groups)[number] | null = null, lastWasAgent = false;
  for (const line of robots.split(/\r?\n/)) {
    const l = line.replace(/#.*/, "").trim(); const i = l.indexOf(":"); if (i < 0) continue;
    const k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1).trim();
    if (k === "user-agent") { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (cur && (k === "allow" || k === "disallow") && v) cur.rules.push({ allow: k === "allow", path: v });
  }
  const g = groups.find((x) => x.agents.some((a) => a.includes("formcraft"))) ?? groups.find((x) => x.agents.includes("*"));
  if (!g) return true;
  const matches = (rule: string) => new RegExp("^" + rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")).test(pathAndQuery);
  const hit = g.rules.filter((r) => matches(r.path)).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow))[0];
  return hit ? hit.allow : true;
}

export interface WebPage { url: string; final_url: string; status: number; content_type: string; fetched_at: string; sha256: string; title: string; text: string; links: WebLink[]; from_cache?: boolean; changed?: boolean }

export function webCacheDir(env = process.env): string { return path.join(env.APPDATA ?? env.HOME ?? ".", "Formcraft", "webcache"); }
const keyOf = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 32);

const lastHit = new Map<string, number>();
const robotsCache = new Map<string, string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait so the host sees at most one request per gapMs from us. */
async function politely(host: string, gapMs: number) {
  const wait = (lastHit.get(host) ?? 0) + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

async function fetchText(url: string, timeoutMs: number): Promise<{ status: number; type: string; body: string; final: string }> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": AGENT, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" } });
    const type = r.headers.get("content-type") ?? "";
    if (/application\/pdf|octet-stream|zip/i.test(type)) return { status: r.status, type, body: "", final: r.url };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) throw new Error("page over 15 MB");
    return { status: r.status, type, body: buf.toString("utf8"), final: r.url };
  } finally { clearTimeout(t); }
}

/**
 * Read a page. From the cache when it is younger than maxAgeH (default a week) unless fresh; otherwise fetched (robots
 * and pacing first) and compared with the cached copy, so `changed` says whether the page moved since last time.
 */
export async function readWeb(url: string, opts: { fresh?: boolean; maxAgeH?: number; gapMs?: number; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<WebPage> {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("read_web reads http and https pages only");
  const dir = webCacheDir(opts.env), file = path.join(dir, `${keyOf(u.toString())}.json`);
  let cached: WebPage | null = null;
  try { cached = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* not read before */ }
  if (cached && !opts.fresh && Date.now() - Date.parse(cached.fetched_at) < (opts.maxAgeH ?? 168) * 3600_000) return { ...cached, from_cache: true };

  const gap = opts.gapMs ?? 3000, timeout = opts.timeoutMs ?? 60_000;
  if (!robotsCache.has(u.host)) {
    await politely(u.host, gap);
    try { const r = await fetchText(`${u.protocol}//${u.host}/robots.txt`, timeout); robotsCache.set(u.host, r.status < 400 ? r.body : ""); } catch { robotsCache.set(u.host, ""); }
  }
  if (!robotsAllows(robotsCache.get(u.host) ?? "", u.pathname + u.search)) throw new Error(`${u.host}'s robots.txt asks agents not to read ${u.pathname}`);
  await politely(u.host, gap);
  const r = await fetchText(u.toString(), timeout);
  if (r.status === 401 || r.status === 403) throw new Error(`${u.host} refused (HTTP ${r.status}): a login or permission is needed; get it by hand`);
  if (r.status >= 400) throw new Error(`HTTP ${r.status} for ${url}`);
  if (!r.body) throw new Error(`${url} is a file (${r.type}), not a page: download it (fmc-fetch-standards) or read it with read_pdf`);
  const html = /html|xml/i.test(r.type) || /<html|<body|<a\s/i.test(r.body.slice(0, 2000));
  const text = html ? htmlToText(r.body) : r.body;
  const page: WebPage = { url: u.toString(), final_url: r.final, status: r.status, content_type: r.type, fetched_at: new Date().toISOString(),
    sha256: createHash("sha256").update(text).digest("hex"), title: html ? titleOf(r.body) : "", text, links: html ? extractLinks(r.body, r.final) : [] };
  page.changed = cached ? cached.sha256 !== page.sha256 : undefined;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(page));
  return page;
}

/** The lines of a page holding all the words (any order, any case), with a line of context each side. */
export function findInText(text: string, words: string, limit = 10): Array<{ line: number; text: string }> {
  const ws = words.toLowerCase().split(/\s+/).filter(Boolean), lines = text.split("\n"), out: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const l = lines[i].toLowerCase();
    if (ws.every((w) => l.includes(w))) out.push({ line: i + 1, text: lines.slice(Math.max(0, i - 1), i + 2).join("\n") });
  }
  return out;
}
