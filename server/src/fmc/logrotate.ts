import fs from "node:fs";
import path from "node:path";

/** Keep a log from growing without bound: when it passes maxBytes, move it to path.1 and start again. */
export function rotateIfLarge(file: string, maxBytes = 1_000_000): boolean {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size <= maxBytes) return false;
  const bak = file + ".1";
  try { fs.rmSync(bak, { force: true }); } catch { /* nothing to replace */ }
  fs.renameSync(file, bak);
  return true;
}

export function appendCapped(file: string, line: string, maxBytes = 1_000_000): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotateIfLarge(file, maxBytes);
  fs.appendFileSync(file, line.endsWith("\n") ? line : line + "\n");
}
