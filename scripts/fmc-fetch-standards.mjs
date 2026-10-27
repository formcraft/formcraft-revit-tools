// Downloads the free standards listed in a manifest into the standards library (owner 27 Oct: "a script to
// download all the free versions", region by region: Uganda, East Africa, West Africa, then the world).
// Polite: robots.txt obeyed, one file at a time with a pause, a named agent, no logins, no paywalls. Only manifest items of kind
// "pdf" are fetched; "page", "request", "form" and "read_online" items go to the report for a person to get.
// A download must start with %PDF- or it is rejected (error pages, login pages). Files already in the library with
// the same content are skipped. Writes <library>/<region>/<country>/<id>__<title>.pdf and a report beside the manifest.
//   node scripts/fmc-fetch-standards.mjs <manifest.json> [--library <folder>] [--pause <s>] [--only <id,id>] [--dry]
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const manifestFile = args.find((a) => !a.startsWith("--") && ![opt("--library"), opt("--pause"), opt("--only")].includes(a));
if (!manifestFile) { console.error("usage: fmc-fetch-standards.mjs <manifest.json> [--library <folder>] [--pause <s>] [--only <ids>] [--dry]"); process.exit(2); }
const library = opt("--library", "D:/Fomcraft/FMC_BIM_27/FMC_Standards_Library");
const pauseMs = Number(opt("--pause", "3")) * 1000;
const only = opt("--only") ? new Set(opt("--only").split(",")) : null;
const dry = args.includes("--dry");
const MAX_BYTES = 250 * 1024 * 1024;

// the same robots.txt reading as read_web: a site that asks agents not to fetch a path is asked of a person instead
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const { robotsAllows, AGENT } = await import(pathToFileURL(path.join(here, "..", "server", "build", "fmc", "webread.js")).href);
const robots = new Map();
async function allowed(url) {
  const u = new URL(url);
  if (!robots.has(u.host)) {
    // no robots.txt (4xx) means no rules; a server error or no answer means the rules are unknown: fetch nothing
    try { const r = await fetch(`${u.protocol}//${u.host}/robots.txt`, { headers: { "User-Agent": AGENT }, signal: AbortSignal.timeout(30_000) }); robots.set(u.host, r.ok ? await r.text() : r.status < 500 ? "" : "User-agent: *\nDisallow: /"); }
    catch { robots.set(u.host, "User-agent: *\nDisallow: /"); }
  }
  return robotsAllows(robots.get(u.host), u.pathname + u.search);
}

const m = JSON.parse(fs.readFileSync(manifestFile, "utf8").replace(/^\uFEFF/, ""));
const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** Every file already in the library by content, so a document saved under another name is not fetched twice. */
const have = new Map();
function scan(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scan(p); else if (e.name.toLowerCase().endsWith(".pdf")) have.set(sha(fs.readFileSync(p)), p);
  }
}
scan(library);

async function get(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 180_000);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": AGENT, Accept: "application/pdf,*/*" } });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const len = Number(r.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) return { error: `too large (${Math.round(len / 1e6)} MB)` };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return { error: `not a PDF (${r.headers.get("content-type") ?? "unknown type"})` };
    return { buf };
  } catch (e) { return { error: e.name === "AbortError" ? "timed out" : String(e.message ?? e) }; } finally { clearTimeout(t); }
}

const report = { manifest: path.basename(manifestFile), run: new Date().toISOString(), library, downloaded: [], skipped: [], failed: [], manual: [] };
const items = (m.items ?? []).filter((i) => !only || only.has(i.id));
for (const it of items) {
  const region = it.region ?? m.region ?? "World", country = it.country ?? m.country ?? "International";
  if (it.kind !== "pdf") { report.manual.push({ id: it.id, title: it.title, kind: it.kind, url: it.url, notes: it.notes ?? "" }); continue; }
  const dir = path.join(library, safe(region), safe(country));
  const file = path.join(dir, `${safe(it.id)}__${safe(it.title)}.pdf`);
  if (fs.existsSync(file)) { report.skipped.push({ id: it.id, file, why: "already in the library" }); continue; }
  if (dry) { report.skipped.push({ id: it.id, file, why: "dry run" }); continue; }
  if (!(await allowed(it.url))) { report.manual.push({ id: it.id, title: it.title, kind: "robots", url: it.url, notes: `${new URL(it.url).host} asks automated agents not to fetch this: download it by hand` }); continue; }
  process.stdout.write(`${it.id} ... `);
  const r = await get(it.url);
  if (r.error) { console.log(r.error); report.failed.push({ id: it.id, title: it.title, url: it.url, error: r.error }); }
  else {
    const h = sha(r.buf);
    if (have.has(h)) { console.log("same file already held"); report.skipped.push({ id: it.id, file: have.get(h), why: "same content already in the library" }); }
    else {
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, r.buf); have.set(h, file);
      console.log(`${(r.buf.length / 1e6).toFixed(1)} MB`);
      report.downloaded.push({ id: it.id, title: it.title, file, bytes: r.buf.length, sha256: h, url: it.url });
    }
  }
  await new Promise((res) => setTimeout(res, pauseMs));
}
const out = manifestFile.replace(/\.json$/i, "") + `.report.json`;
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\n${report.downloaded.length} downloaded, ${report.skipped.length} already held, ${report.failed.length} failed, ${report.manual.length} to get by hand`);
for (const f of report.failed) console.log(`  failed  ${f.id}: ${f.error}  ${f.url}`);
for (const x of report.manual) console.log(`  by hand ${x.id} (${x.kind}): ${x.url ?? ""}`);
console.log(`report: ${out}`);
