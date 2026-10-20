/**
 * Rhino proof before Revit (owner 20 Oct; kit FMC_Rulebook_Rhino.json RHN-010, RHN-011). A complex shape is proven
 * buildable in Rhino before Revit time is spent on it: every import_part file must be one that fmc_rhino export_parts
 * wrote after the check passed (parts.json beside it, check.ok, the rulebook's version, the same SHA-256 now), and a
 * recipe marked rhino_required must carry its curved parts as import_part. Pure: the caller reads the files.
 */
import path from "node:path";
import type { RhinoRulebook } from "./rhino.js";

export interface PartsManifest {
  family?: string;
  check?: { ok?: boolean; rulebook?: string; rulebook_version?: string };
  parts?: Array<{ name?: string; file?: string; sha256?: string }>;
}

export interface ProofIo {
  /** parts.json in the part file's folder, or null when there is none. */
  manifest: (folder: string) => PartsManifest | null;
  /** The file's SHA-256 now, or null when it doesn't exist. */
  sha256: (file: string) => string | null;
}

const win = path.win32;
const same = (a: string, b: string) => win.normalize(a).toLowerCase() === win.normalize(b).toLowerCase();

export function rhinoProofProblems(ops: Array<Record<string, any>>, checks: Record<string, any> | undefined, book: RhinoRulebook | null, io: ProofIo): string[] {
  const imports = ops.filter((o) => o.op === "import_part");
  const out: string[] = [];
  if (checks?.rhino_required && imports.length === 0)
    out.push("RHN-011: the recipe is marked rhino_required (a complex shape) but has no import_part: model its curved parts in Rhino first (fmc_rhino part, check, export_parts)");
  if (imports.length === 0) return out;
  if (!book) return [...out, "RHN-010: no Rhino rulebook in the kit, so no Rhino part counts as proven: add FMC_Rulebook_Rhino.json (kit change request)"];
  if (!book.proof.rhino_first) return out;
  const manifests = new Map<string, PartsManifest | null>();
  for (const o of imports) {
    const file = String(o.file ?? "");
    const folder = win.dirname(file);
    if (!manifests.has(folder)) manifests.set(folder, io.manifest(folder));
    const m = manifests.get(folder);
    const label = `${o.name}: ${win.basename(file)}`;
    if (!m) { out.push(`RHN-010 ${label} has no parts.json beside it: it wasn't exported by fmc_rhino export_parts after a passing check`); continue; }
    if (!m.check?.ok) { out.push(`RHN-010 ${label}: its export doesn't record a passing Rhino check (exported before the rulebook): export it again`); continue; }
    if (m.check.rulebook_version !== book.version)
      out.push(`RHN-010 ${label}: checked under Rhino rulebook ${m.check.rulebook_version || "?"}, the kit's is ${book.version}: check and export it again`);
    const entry = (m.parts ?? []).find((p) => p.file && same(String(p.file), file));
    if (!entry) { out.push(`RHN-010 ${label} isn't in its parts.json: export it again`); continue; }
    const now = io.sha256(file);
    if (now === null) out.push(`RHN-010 ${label} is missing on disk`);
    else if (entry.sha256 && now.toLowerCase() !== entry.sha256.toLowerCase())
      out.push(`RHN-010 ${label} changed after its check (SHA-256 differs): check and export it again`);
  }
  return out;
}
