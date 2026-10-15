/**
 * The build this server process runs, against the build on disk (F-042, issue #143).
 *
 * The updater replaces the server's files while the Claude app keeps its MCP server process running: the process
 * still runs the code it loaded at startup (old tools, old op schemas), while build-info.json on disk already names
 * the new build. So the running build is read once, when this module loads at startup, and kept in memory; the disk
 * is read again whenever it is compared. fmc_selftest fails when they differ, and every "invalid op" error names the
 * running build so the AI sees the cause instead of guessing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildStamp { commit: string; built: string }

const UNKNOWN: BuildStamp = { commit: "unknown", built: "" };

/** build/build-info.json (written by scripts/build-info.mjs after tsc), beside build/fmc/. */
export const BUILD_INFO_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build-info.json");

export function readBuildInfo(file: string = BUILD_INFO_FILE, reader: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): BuildStamp {
  try {
    const j = JSON.parse(reader(file).replace(/^﻿/, ""));
    return { commit: String(j.commit ?? "unknown") || "unknown", built: String(j.built ?? "") };
  } catch {
    return { ...UNKNOWN };
  }
}

/** Read once, at startup: the build this process is running. Never re-read. */
export const RUNNING_BUILD: BuildStamp = Object.freeze(readBuildInfo());

/** The build on disk now (the updater may have replaced it since this process started). */
export function diskBuild(): BuildStamp {
  return readBuildInfo();
}

const bare = (c: string) => c.replace(/\+local$/, "");

/**
 * True when the process runs another build than the one installed on disk: another commit, or (for "+local" builds
 * of uncommitted changes, where the commit says too little) the same commit built at another time.
 */
export function buildDrift(running: BuildStamp, disk: BuildStamp): boolean {
  if (running.commit === "unknown" || disk.commit === "unknown") return false;
  if (bare(running.commit) !== bare(disk.commit)) return true;
  const local = running.commit.endsWith("+local") || disk.commit.endsWith("+local");
  return local && !!running.built && !!disk.built && running.built !== disk.built;
}

export function restartAdvice(disk: BuildStamp): string {
  return `Restart the Claude app (or its Formcraft connector) to load build ${disk.commit}`;
}

/** Zod's discriminated-union refusal ("Invalid discriminator value"), or any "invalid/unknown op" message. */
export function isInvalidOpMessage(text: string): boolean {
  // zod 3 "Invalid discriminator value", zod 4 "No matching discriminator", and the tools' own wording
  return /invalid discriminator|no matching discriminator|invalid_union_discriminator|invalid op\b|unknown op\b|unknown fmc_doc op/i.test(text);
}

/** The note an "invalid op" error carries: the running build, and the restart advice when the disk is newer. */
export function invalidOpNote(running: BuildStamp, disk: BuildStamp): string {
  const base = `This server process runs build ${running.commit}${running.built ? ` (built ${running.built})` : ""}`;
  if (buildDrift(running, disk))
    return `${base}, but build ${disk.commit} is installed: the op may be newer than the running server. ${restartAdvice(disk)}.`;
  return `${base}; the installed build is the same, so the op isn't one this build knows.`;
}

/**
 * Adds the note to an "invalid op" text once; other texts come back unchanged. A JSON object (a tool's reply, which
 * the pane parses) gets running_build and build_note fields; plain text gets the note on a new line.
 */
export function annotateInvalidOp(text: string, running: BuildStamp = RUNNING_BUILD, disk: BuildStamp = diskBuild()): string {
  if (!isInvalidOpMessage(text) || text.includes("This server process runs build")) return text;
  const note = invalidOpNote(running, disk);
  try {
    const o = JSON.parse(text);
    if (o && typeof o === "object" && !Array.isArray(o)) return JSON.stringify({ ...o, running_build: running.commit, build_note: note }, null, 2);
  } catch { /* plain text */ }
  return `${text}\n${note}`;
}

/** A tool result whose error text says "invalid op" gets the running build in its text (other results unchanged). */
export function annotateToolResult<T>(result: T, running: BuildStamp = RUNNING_BUILD, disk: () => BuildStamp = diskBuild): T {
  const r = result as unknown as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  if (!r || typeof r !== "object" || !Array.isArray(r.content)) return result;
  // An error result, or a refusal a tool returns as data (fmc_recipe's recipe problems)
  if (!r.isError && !r.content.some((c) => typeof c.text === "string" && /"refused"\s*:\s*true|"error"\s*:|"errors"\s*:\s*\[\s*"/.test(c.text))) return result;
  if (!r.content.some((c) => typeof c.text === "string" && isInvalidOpMessage(c.text))) return result;
  const d = disk();
  return { ...(r as object), content: r.content.map((c) => (typeof c.text === "string" ? { ...c, text: annotateInvalidOp(c.text, running, d) } : c)) } as T;
}
