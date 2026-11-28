/**
 * fmc_build baseline: save the current quantities as the baseline the later measures compare against.
 * It overwrote an existing baseline in one call, losing what every later "changed since baseline" flag is measured from.
 * Now it is a dry run unless dry_run is false; an existing baseline is replaced only with confirm true; and the old one is
 * copied to _Archive\<name>.<timestamp>.json first (if the copy fails, nothing is overwritten).
 */
import fs from "node:fs";
import path from "node:path";

const win = path.win32;

export const BASELINE_CONFIRM = "FMC-BUILD-BASELINE-CONFIRM";
export const BASELINE_ARCHIVE_FAILED = "FMC-BUILD-BASELINE-ARCHIVE-FAILED";

export interface BaselineIo {
  exists: (file: string) => boolean;
  read: (file: string) => string;
  write: (file: string, text: string) => void;
  mkdir: (dir: string) => void;
}

export const realIo: BaselineIo = {
  exists: (f) => fs.existsSync(f),
  read: (f) => fs.readFileSync(f, "utf8"),
  write: (f, t) => fs.writeFileSync(f, t),
  mkdir: (d) => { fs.mkdirSync(d, { recursive: true }); },
};

/** <dir>\_Archive\<name>.<yyyymmdd-hhmmss-mmm>.json */
export function archivePath(file: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-").replace("Z", "");
  const base = win.basename(file).replace(/\.json$/i, "");
  return win.join(win.dirname(file), "_Archive", `${base}.${stamp}.json`);
}

export interface BaselineResult {
  ok: boolean;
  dry_run: boolean;
  written: boolean;
  file: string;
  existed: boolean;
  archived?: string;
  would_archive?: string;
  code?: string;
  message?: string;
}

/** Plans or performs the write. No write at all when dry_run (the default), or when an existing baseline isn't confirmed. */
export function saveBaseline(file: string, body: string, opts: { dryRun?: boolean; confirm?: boolean; now?: Date }, io: BaselineIo = realIo): BaselineResult {
  const dryRun = opts.dryRun !== false;
  const confirm = opts.confirm === true;
  const now = opts.now ?? new Date();
  const existed = io.exists(file);
  const archive = existed ? archivePath(file, now) : undefined;
  if (dryRun)
    return { ok: true, dry_run: true, written: false, file, existed, ...(archive ? { would_archive: archive } : {}),
      message: existed ? "Dry run: nothing was written. The existing baseline would be archived, then replaced (dry_run false and confirm true)." : "Dry run: nothing was written. There is no baseline yet; dry_run false writes it." };
  if (existed && !confirm)
    return { ok: false, dry_run: false, written: false, file, existed, would_archive: archive, code: BASELINE_CONFIRM,
      message: `[${BASELINE_CONFIRM}] A baseline already exists at ${file}. Replacing it moves what every later measure is compared with: pass confirm true to archive it (to ${archive}) and replace it. Nothing was changed.` };
  if (existed && archive) {
    try {
      io.mkdir(win.dirname(archive));
      io.write(archive, io.read(file));
      if (!io.exists(archive)) throw new Error("the archive copy is not there after writing");
    } catch (e) {
      return { ok: false, dry_run: false, written: false, file, existed, would_archive: archive, code: BASELINE_ARCHIVE_FAILED,
        message: `[${BASELINE_ARCHIVE_FAILED}] The old baseline could not be archived (${e instanceof Error ? e.message : String(e)}), so it was not overwritten.` };
    }
  }
  io.mkdir(win.dirname(file));
  io.write(file, body);
  return { ok: true, dry_run: false, written: true, file, existed, ...(existed && archive ? { archived: archive } : {}) };
}
