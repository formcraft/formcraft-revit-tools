/**
 * Project-folder gate lint (plan §3.6, JAIL T19): every tool argument that names a file or folder must go through the
 * jail (jailArgs / checkArg in fmc/jailctx.ts). Pure text scan of src/tools/*.ts, so it runs in a test without Revit.
 *
 * A path-like argument is a Zod shape key whose name says it is a path (path, file, folder, dir, workbook, copy_to,
 * seed_path, central, ...). It is routed when the same file passes that name to jailArgs or checkArg. The baseline
 * (fixtures/jail_lint_baseline.json) lists the arguments not routed yet (Phase 5 per-tool migrations); a new path
 * argument that is neither routed nor in the baseline fails, and so does a baseline entry that is now routed.
 */
export const PATH_ARG = /^(?:[a-z0-9]+_)*(?:path|paths|file|files|folder|folders|dir|dirs|workbook|copy_to|save_path|seed_path|central|template|templates|out|root|roots|source_file|target_file|link_from|keynote_file|batch_file|cis_file|facts_file|pdf_path|results_dir|scenarios_dir|kit_folder|project_folder|image_dir|save_to)$/;

/** Not paths, although the name matches (ids, flags, document names that the add-in resolves among open documents). */
export const NOT_A_PATH = new Set(["dry_run", "template_name", "family_template", "root_id", "out_format"]);

/** Zod shape keys in a tool file: `name: z.` at the start of a line. */
export function shapeKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const m of source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*z\s*\./gm)) keys.add(m[1]);
  return [...keys];
}

export function pathArgs(source: string): string[] {
  return shapeKeys(source).filter((k) => PATH_ARG.test(k) && !NOT_A_PATH.has(k));
}

/** True when the file hands `param` to the jail. */
export function routed(source: string, param: string): boolean {
  const q = param.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\[\\s*"${q}"\\s*,\\s*[^,\\]]*?"(?:read|write|list|open)"`).test(source) ||
    new RegExp(`checkArg\\([^;]*?"(?:read|write|list|open)"\\s*,\\s*"${q}"`).test(source);
}

export interface LintResult { unrouted: string[]; staleBaseline: string[]; routedCount: number }

/** files: tool file name → source. baseline: "tool.ts:param" entries. */
export function lintTools(files: Record<string, string>, baseline: string[]): LintResult {
  const base = new Set(baseline);
  const unrouted: string[] = [];
  const staleBaseline: string[] = [];
  let routedCount = 0;
  for (const [name, src] of Object.entries(files)) {
    for (const p of pathArgs(src)) {
      const key = `${name}:${p}`;
      if (routed(src, p)) { routedCount++; if (base.has(key)) staleBaseline.push(key); }
      else if (!base.has(key)) unrouted.push(key);
    }
  }
  return { unrouted: unrouted.sort(), staleBaseline: staleBaseline.sort(), routedCount };
}
