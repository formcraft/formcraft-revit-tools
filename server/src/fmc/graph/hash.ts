/** Hashes for the graph tools: SHA-256 of files, folders and stable JSON. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha256Text(text: string | Buffer): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function sha256File(file: string): string {
  return sha256Text(fs.readFileSync(file));
}

/** JSON with object keys sorted at every level and no whitespace. Arrays keep their order. */
export function stableJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    }
    return v === undefined ? null : v;
  };
  return JSON.stringify(norm(value));
}

export function inputsHash(inputs: unknown): string {
  return sha256Text(stableJson(inputs ?? {}));
}

/**
 * One hash for a folder: the sorted relative paths and each file's SHA-256. Capped so a huge folder cannot stall a call;
 * a capped folder says so in the hash input ("…truncated"), so it never matches an uncapped hash by accident.
 */
export function sha256Folder(dir: string, cap = 2000): string {
  const rows: string[] = [];
  const walk = (current: string, rel: string) => {
    if (rows.length >= cap) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (rows.length >= cap) { rows.push("…truncated"); return; }
      const full = path.join(current, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { rows.push(`${r}:link`); continue; }
      if (entry.isDirectory()) walk(full, r);
      else if (entry.isFile()) {
        let h = "";
        try { h = sha256File(full); } catch { h = "unreadable"; }
        rows.push(`${r}:${h}`);
      }
    }
  };
  walk(dir, "");
  return sha256Text(rows.join("\n"));
}
