import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findInText, readWeb } from "../fmc/webread.js";

export const READ_WEB_DESCRIPTION =
  "Formcraft's built-in web reader (owner 27 Oct), read-only: law portals, standards bodies, ministries and manufacturers' " +
  "product pages. action read {url}: the page as text (headings, lists, tables kept). links {url, kinds?, match?}: its " +
  "links, with downloadable files typed (pdf catalogues and standards, rfa/ifc/dwg models, zip). find {url, words}: the " +
  "lines holding them. check {url}: has the page changed since it was last read (new edition, amendment, new products). " +
  "Pages are cached for a week (fresh: true reads again). Obeys robots.txt, paces requests, no logins or paywalls: a " +
  "refused page is for a person to get. Files themselves are downloaded with scripts/fmc-fetch-standards.mjs.";

const reply = (body: object, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError });

export function registerReadWebTool(server: McpServer) {
  server.tool("read_web", READ_WEB_DESCRIPTION, {
    url: z.string().url(),
    action: z.enum(["read", "links", "find", "check"]).optional().default("read"),
    kinds: z.array(z.string()).optional().describe("links: only these kinds, e.g. [\"pdf\", \"rfa\"]; \"files\" for every file kind"),
    match: z.string().optional().describe("links: only links whose address or text contains this (case-insensitive)"),
    same_site: z.boolean().optional().describe("links: only links on the same site"),
    words: z.string().optional().describe("find: the words to look for"),
    from: z.number().int().min(0).optional().default(0).describe("read: character to start from (long pages come in parts)"),
    max_chars: z.number().int().min(500).max(40000).optional().default(12000),
    fresh: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(500).optional().default(100),
  }, async (args) => {
    try {
      const t0 = Date.now();
      const p = await readWeb(args.url, { fresh: args.fresh || args.action === "check" });
      const base = { url: p.final_url, title: p.title, fetched_at: p.fetched_at, from_cache: !!p.from_cache, ms: Date.now() - t0 };
      if (args.action === "check") return reply({ ...base, changed: p.changed ?? "first read", sha256: p.sha256 });
      if (args.action === "find") {
        if (!args.words?.trim()) return reply({ error: "find needs words" }, true);
        return reply({ ...base, found: findInText(p.text, args.words, Math.min(args.limit, 30)) });
      }
      if (args.action === "links") {
        const q = args.match?.toLowerCase();
        const kinds = args.kinds?.length ? new Set(args.kinds.map((k) => k.toLowerCase())) : null;
        const ls = p.links.filter((l) => (!kinds || kinds.has(l.kind) || (kinds.has("files") && l.kind !== "page"))
          && (!q || l.url.toLowerCase().includes(q) || l.text.toLowerCase().includes(q)) && (!args.same_site || l.same_site));
        const byKind: Record<string, number> = {};
        for (const l of p.links) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
        return reply({ ...base, all_links: p.links.length, by_kind: byKind, shown: Math.min(ls.length, args.limit), links: ls.slice(0, args.limit) });
      }
      const to = Math.min(p.text.length, args.from + args.max_chars);
      return reply({ ...base, chars: p.text.length, from: args.from, to, ...(to < p.text.length ? { more: `from: ${to}` } : {}), text: p.text.slice(args.from, to) });
    } catch (e) {
      return reply({ error: e instanceof Error ? e.message : String(e) }, true);
    }
  });
}
