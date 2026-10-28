// Read prices from the sources in FMC_Price_Sources.json (robots.txt obeyed, pages cached, PDFs read with the server's
// PDF reader) and list every line that names an item with a price, as candidates for the price book. Nothing is
// written into the price book: scripts/cost/price-accept.py takes a reviewed candidate in.
//   node scripts/cost/price-scrape.mjs <kit 07_Materials dir> [--only "<source name part>"]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const B = new URL("../../server/build/fmc/", import.meta.url);
const { readWeb, robotsAllows, webCacheDir, AGENT } = await import(new URL("webread.js", B).href);
const { readPdf } = await import(new URL("pdfread.js", B).href);
const [D, ...rest] = process.argv.slice(2);
const only = rest.includes("--only") ? rest[rest.indexOf("--only") + 1].toLowerCase() : "";
const src = JSON.parse(fs.readFileSync(path.join(D, "FMC_Price_Sources.json"), "utf8")).sources.filter((s) => !only || s.name.toLowerCase().includes(only));
const today = new Date().toISOString().slice(0, 10);
const money = /(?:ugx|ushs?|shs?\.?)\s*([0-9][0-9,]{2,})|([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,7})(?!\s*(?:%|kg\b|mm\b|m2\b|m3\b))/gi;

async function pdfText(url) {
  const u = new URL(url), robotsUrl = `${u.origin}/robots.txt`;
  let robots = "";
  try { const r = await fetch(robotsUrl, { headers: { "user-agent": AGENT } }); robots = r.status >= 400 && r.status < 500 ? "" : r.ok ? await r.text() : "User-agent: *\nDisallow: /"; }
  catch { robots = "User-agent: *\nDisallow: /"; }
  if (!robotsAllows(robots, u.pathname + u.search)) throw new Error("robots.txt does not allow it");
  const dir = path.join(webCacheDir(), "prices"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, u.hostname + u.pathname.replace(/[^\w.]+/g, "_"));
  if (!fs.existsSync(file) || Date.now() - fs.statSync(file).mtimeMs > 7 * 864e5) {
    const r = await fetch(url, { headers: { "user-agent": AGENT } }); if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.subarray(0, 5).toString() !== "%PDF-") throw new Error("not a PDF"); fs.writeFileSync(file, buf);
  }
  const doc = await readPdf(file); return doc.pages.map((p) => p.text ?? p).join("\n");
}

const rows = [];
for (const s of src) {
  let text = "";
  try { text = s.kind === "pdf" ? await pdfText(s.url) : (await readWeb(s.url)).text; }
  catch (e) { console.log(`${s.name}: ${e.message}`); continue; }
  const lines = text.split(/\r?\n|(?<=[.;])\s+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  let n = 0;
  for (const it of s.items) for (const l of lines) {
    const low = l.toLowerCase(); if (!it.terms.some((t) => low.includes(t))) continue;
    const nums = [...l.matchAll(money)].map((m) => Number((m[1] ?? m[2]).replace(/,/g, ""))).filter((v) => v >= 100 && !(v >= 1990 && v <= 2035));
    if (!nums.length) continue;
    const v = it.pick === "first" ? nums[0] : it.pick === "max" ? Math.max(...nums) : nums[nums.length - 1];
    rows.push([it.key, v, nums.join(" "), l.slice(0, 220), s.name, s.url, today]); n++;
  }
  console.log(`${s.name}: ${n} candidate lines`);
}
const csv = (v) => `"${String(v).replace(/"/g, '""')}"`;
const out = path.join(D, "FMC_Price_Candidates.csv");
fs.writeFileSync(out, "key,value,all_numbers,line,source,url,read\n" + rows.map((r) => r.map(csv).join(",")).join("\n") + "\n");
console.log(`${rows.length} candidates -> ${out}`);
