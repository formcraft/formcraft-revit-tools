import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findIn, paragraph, readPdf } from "../fmc/pdfread.js";

export const READ_PDF_DESCRIPTION =
  "Formcraft's built-in PDF reader (owner 27 Oct), read-only: codes, standards, briefs, catalogues. Each PDF is read once " +
  "and kept by its fingerprint (sha256), so later calls are instant and a changed copy is read again. Gazette PDFs whose " +
  "fonts shift the letters are decoded. action info: pages, fingerprint and the paragraph numbers found. find {words}: " +
  "the pages holding them, best first, with the matching lines. para {numbers}: a paragraph's text from its heading to " +
  "the next (the body copy). pages {from, to}: the text of those pages (at most 10). Text only: figures, drawings and " +
  "scanned pages don't come through; say so and log them as gaps (fmc_standards sources).";

const reply = (body: object, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError });

export function registerReadPdfTool(server: McpServer) {
  server.tool("read_pdf", READ_PDF_DESCRIPTION, {
    file: z.string().describe("The PDF's full path"),
    action: z.enum(["info", "find", "para", "pages"]).optional().default("info"),
    words: z.string().optional().describe("find: the words to look for"),
    numbers: z.array(z.union([z.string(), z.number()])).max(20).optional().describe("para: paragraph or regulation numbers, e.g. [41, 43]"),
    from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(30).optional().default(10),
  }, async (args) => {
    try {
      const t0 = Date.now();
      const doc = await readPdf(args.file);
      const base = { file: args.file, pages: doc.pages.length, sha256: doc.sha256, ...(doc.shifted_fonts ? { decoded_fonts: doc.shifted_fonts } : {}) };
      const ms = () => ({ ms: Date.now() - t0 });
      if (args.action === "find") {
        if (!args.words?.trim()) return reply({ error: "find needs words" }, true);
        return reply({ ...base, found: findIn(doc, args.words, args.limit), ...ms() });
      }
      if (args.action === "para") {
        const out = (args.numbers ?? []).map((n) => paragraph(doc, String(n)) ?? { para: String(n), missing: true });
        return reply({ ...base, paragraphs: out, ...ms() });
      }
      if (args.action === "pages") {
        const from = args.from ?? 1, to = Math.min(args.to ?? from, from + 9, doc.pages.length);
        return reply({ ...base, from, to, text: doc.pages.slice(from - 1, to).map((t, i) => `=== page ${from + i}\n${t}`).join("\n"), ...ms() });
      }
      const paras = Object.keys(doc.paras).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
      return reply({ ...base, read_at: doc.read_at, paragraphs: paras.length ? `${paras[0]}-${paras[paras.length - 1]} (${paras.length})` : "none numbered",
        words_indexed: Object.keys(doc.words).length, ...ms() });
    } catch (e) {
      return reply({ error: e instanceof Error ? e.message : String(e) }, true);
    }
  });
}
