import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DriveKind, DrivePort, FileReader, JsonStore, LogSink, TxFs, CENTRAL_LOG_HEADER } from "./central.js";
import { TreeWriter } from "./iso19650.js";
import { csvLine } from "./policy.js";
import { defaultCentralTempRoot, deleteOwnTemp } from "./centralguard.js";

const win = path.win32;

/** Real file ports for fmc_central and fmc_iso_folders. Tests use them on temp folders only. */
export const realReader: FileReader = {
  exists: (p) => fs.existsSync(p),
  readJson: (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } },
  list: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
  size: (p) => { try { return fs.statSync(p).size; } catch { return null; } },
};

export const realTreeWriter: TreeWriter = {
  exists: (p) => fs.existsSync(p),
  isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  list: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
  mkdir: (p) => { fs.mkdirSync(p, { recursive: true }); },
  writeNew: (p, content) => { fs.writeFileSync(p, content, { flag: "wx" }); },
};

/**
 * Transaction file moves. removeOwnTemp only deletes inside tempRoot (the transaction's own temp builds), so a wrong
 * path can never delete anything on the share.
 */
export function realTxFs(tempRoot: string, kind: (root: string) => DriveKind = windowsDriveKind): TxFs {
  return {
    exists: (p) => fs.existsSync(p),
    mkdir: (p) => { fs.mkdirSync(p, { recursive: true }); },
    move: (from, to) => {
      if (fs.existsSync(to)) throw new Error(`${to} exists; a move never overwrites`);
      try { fs.renameSync(from, to); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
        fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
        fs.rmSync(from, { recursive: true, force: false });
      }
    },
    removeOwnTemp: (p) => {
      deleteOwnTemp(p, tempRoot, (x) => { fs.rmSync(x, { recursive: true, force: true }); }, kind);
    },
  };
}

export function fileStore(file: string): JsonStore {
  return {
    read: () => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } },
    write: (text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + ".tmp", text); fs.renameSync(file + ".tmp", file); },
  };
}

export function csvLog(file: string): LogSink {
  return {
    append: (line) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(CENTRAL_LOG_HEADER));
      fs.appendFileSync(file, line);
    },
  };
}

/** Win32_LogicalDisk DriveType: 2 removable, 3 local, 4 network. UNC paths are network without asking. */
export function windowsDriveKind(root: string, run: (letter: string) => string = psDriveType): DriveKind {
  if (/^\\\\/.test(root)) return "network";
  const m = /^([A-Za-z]):/.exec(root);
  if (!m) return "unknown";
  try {
    const t = run(m[1].toUpperCase()).trim();
    return t === "4" ? "network" : t === "3" ? "local" : t === "2" ? "removable" : "unknown";
  } catch { return "unknown"; }
}

function psDriveType(letter: string): string {
  if (!/^[A-Z]$/.test(letter)) return "";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'").DriveType`], { encoding: "utf8", timeout: 15000, windowsHide: true });
}

export const realDrive: DrivePort = {
  kind: (p) => windowsDriveKind(p),
  reachable: (p) => { try { fs.statfsSync(p); return fs.existsSync(p); } catch { return false; } },
  freeBytes: (p) => { try { const s = fs.statfsSync(p); return Number(s.bavail) * Number(s.bsize); } catch { return null; } },
};

export const DEFAULT_TEMP_ROOT = (env: NodeJS.ProcessEnv = process.env) => defaultCentralTempRoot(env);
