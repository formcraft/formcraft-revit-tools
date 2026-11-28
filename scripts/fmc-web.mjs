// The web reader from the command line (same rules as read_web: robots.txt, pacing, cache, no logins).
//   node scripts/fmc-web.mjs read  <url> [--from N] [--max N] [--fresh]
//   node scripts/fmc-web.mjs links <url> [--kinds pdf,rfa | files] [--match text] [--same-site]
//   node scripts/fmc-web.mjs find  <url> <words...>
//   node scripts/fmc-web.mjs check <url>
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const { readWeb, findInText } = await import(pathToFileURL(path.join(here, "..", "server", "build", "fmc", "webread.js")).href);
const [cmd, url, ...rest] = process.argv.slice(2);
const opt = (n, d) => (rest.indexOf(n) >= 0 ? rest[rest.indexOf(n) + 1] : d);
if (!cmd || !url) { console.error("usage: fmc-web.mjs read|links|find|check <url> [...]"); process.exit(2); }
try {
  const p = await readWeb(url, { fresh: rest.includes("--fresh") || cmd === "check" });
  if (cmd === "check") console.log(JSON.stringify({ url: p.final_url, changed: p.changed ?? "first read", sha256: p.sha256 }));
  else if (cmd === "find") for (const f of findInText(p.text, rest.filter((r) => !r.startsWith("--")).join(" "), 30)) console.log(`--- line ${f.line}\n${f.text}`);
  else if (cmd === "links") {
    const kinds = opt("--kinds") ? new Set(opt("--kinds").split(",")) : null, q = opt("--match")?.toLowerCase();
    for (const l of p.links) {
      if (kinds && !kinds.has(l.kind) && !(kinds.has("files") && l.kind !== "page")) continue;
      if (q && !l.url.toLowerCase().includes(q) && !l.text.toLowerCase().includes(q)) continue;
      if (rest.includes("--same-site") && !l.same_site) continue;
      console.log(`${l.kind}\t${l.url}\t${l.text}`);
    }
  } else {
    const from = Number(opt("--from", "0")), max = Number(opt("--max", "20000"));
    console.log(`# ${p.title}\n# ${p.final_url} (${p.text.length} chars${p.from_cache ? ", cached" : ""})\n`);
    console.log(p.text.slice(from, from + max));
    if (from + max < p.text.length) console.log(`\n[more: --from ${from + max}]`);
  }
} catch (e) { console.error(`refused or failed: ${e.message}`); process.exit(1); }
