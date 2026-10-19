/**
 * Offline voice-note transcription (docs/PLAN_MARK_REVIEW.md, R2): whisper.cpp's command-line tool (MIT licence) on the
 * PC's processor, at below-normal priority so Revit stays responsive. The "small" model by default (clearly more accurate
 * than "base" on site English and accents), "medium" for PCs with the memory. Nothing leaves the PC.
 *
 *   %LOCALAPPDATA%\Formcraft\whisper\bin\whisper-cli.exe   (and its DLLs, from the official Windows x64 release)
 *   %LOCALAPPDATA%\Formcraft\whisper\models\ggml-<model>.bin
 *
 * whisper.cpp reads 16 kHz mono 16-bit PCM WAV only; the pane records exactly that. Other audio is refused with the
 * reason (no ffmpeg is shipped). The child process is injectable (Runner), so the tests run without whisper.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readZip } from "./zip.js";

const win = path.win32;

export const WHISPER_MODELS = ["small", "medium"] as const;
export type WhisperModel = (typeof WHISPER_MODELS)[number];

/**
 * Where the binary and the models come from: the one place to change them.
 * - bin: whisper.cpp v1.9.2 (4 Aug 2026), the CPU build for Windows x64 from the project's GitHub releases. Pinned to a
 *   release, not "latest", so every PC runs the same build; sha256 is GitHub's published asset digest.
 * - models: ggml models from the ggerganov/whisper.cpp Hugging Face repo, pinned to commit 5359861 so the file cannot
 *   change under us; sha256 is the Git LFS object id Hugging Face publishes for each file (X-Linked-ETag).
 */
export const WHISPER_DOWNLOADS = {
  bin: {
    version: "v1.9.2",
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip",
    sha256: "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a",
    bytes: 8194445,
  },
  models: {
    small: {
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin",
      sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
      bytes: 487601967,
    },
    medium: {
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-medium.bin",
      sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
      bytes: 1533763059,
    },
  } as Record<WhisperModel, { url: string; sha256: string; bytes: number }>,
};

/** %LOCALAPPDATA%\Formcraft\whisper (FMC_WHISPER_DIR overrides it, for tests and odd installs). */
export function whisperHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FMC_WHISPER_DIR) return env.FMC_WHISPER_DIR;
  const local = env.LOCALAPPDATA || win.join(env.USERPROFILE || os.homedir(), "AppData", "Local");
  return win.join(local, "Formcraft", "whisper");
}

export function whisperPaths(home: string, model: WhisperModel = "small") {
  return { bin: win.join(home, "bin"), cli: win.join(home, "bin", "whisper-cli.exe"), models: win.join(home, "models"), model: win.join(home, "models", `ggml-${model}.bin`) };
}

export interface WhisperStatus {
  home: string;
  cli: { path: string; installed: boolean; version?: string };
  models: Array<{ model: WhisperModel; path: string; installed: boolean; mb: number; download_mb: number }>;
  ready: boolean;
}

/**
 * What is installed. A model counts when setup verified its SHA-256 (the ".verified" file beside it holds the hash), or,
 * for a model copied in by hand, when it has the full published size (a half download is not a model).
 */
export function whisperStatus(home: string, model: WhisperModel = "small"): WhisperStatus {
  const p = whisperPaths(home, model);
  let version: string | undefined;
  try { version = fs.readFileSync(win.join(p.bin, "VERSION.txt"), "utf8").trim() || undefined; } catch { /* not written by older setups */ }
  const models = WHISPER_MODELS.map((m) => {
    const file = whisperPaths(home, m).model, want = WHISPER_DOWNLOADS.models[m];
    let size = -1, verified = "";
    try { size = fs.statSync(file).size; } catch { size = -1; }
    try { verified = fs.readFileSync(file + ".verified", "utf8").trim(); } catch { verified = ""; }
    return { model: m, path: file, installed: size >= 0 && (size === want.bytes || verified === want.sha256), mb: Math.round(Math.max(0, size) / 1e6), download_mb: Math.round(want.bytes / 1e6) };
  });
  const cli = { path: p.cli, installed: fs.existsSync(p.cli), ...(version ? { version } : {}) };
  return { home, cli, models, ready: cli.installed && models.find((m) => m.model === model)!.installed };
}

// ---------------------------------------------------------------------------------------------------------------- audio

export interface WavInfo { format: number; channels: number; sample_rate: number; bits: number; data_bytes: number; seconds: number }

/** The header of a RIFF/WAVE file, or the reason it isn't one. Reads only the first 64 KB. */
export function readWavHeader(buf: Buffer): WavInfo | string {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return "it isn't a WAV file";
  let p = 12;
  let fmt: Omit<WavInfo, "data_bytes" | "seconds"> | undefined;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === "fmt " && p + 24 <= buf.length) {
      let format = buf.readUInt16LE(p + 8);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID
      if (format === 0xfffe && p + 34 <= buf.length) format = buf.readUInt16LE(p + 32);
      fmt = { format, channels: buf.readUInt16LE(p + 10), sample_rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    } else if (id === "data") {
      if (!fmt) return "its format chunk is missing";
      const bytesPerSecond = fmt.sample_rate * fmt.channels * (fmt.bits / 8);
      return { ...fmt, data_bytes: size, seconds: bytesPerSecond ? Math.round((size / bytesPerSecond) * 10) / 10 : 0 };
    }
    p += 8 + size + (size % 2);
  }
  return fmt ? "it has no audio data" : "its format chunk is missing";
}

/** Why whisper.cpp can't read this audio (empty: it can). */
export function wavProblems(info: WavInfo | string): string[] {
  if (typeof info === "string") return [`The voice note can't be transcribed: ${info}. whisper.cpp reads 16 kHz mono 16-bit WAV; record it in the pane, or convert it first`];
  const p: string[] = [];
  if (info.format !== 1) p.push(`it is compressed (WAV format ${info.format}), not plain PCM`);
  if (info.sample_rate !== 16000) p.push(`it is ${info.sample_rate} Hz, not 16000 Hz`);
  if (info.channels !== 1) p.push(`it has ${info.channels} channels, not 1 (mono)`);
  if (info.bits !== 16) p.push(`it is ${info.bits}-bit, not 16-bit`);
  if (!p.length && info.data_bytes < 3200) p.push("it is shorter than a tenth of a second");
  return p.length ? [`The voice note can't be transcribed: ${p.join("; ")}. whisper.cpp reads 16 kHz mono 16-bit WAV; record it in the pane, or convert it first`] : [];
}

export function wavFileProblems(file: string): string[] {
  if (!fs.existsSync(file)) return [`No audio file at ${file}`];
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return wavProblems(readWavHeader(buf.subarray(0, n)));
  } finally { fs.closeSync(fd); }
}

// ------------------------------------------------------------------------------------------------------- the child run

export interface RunResult { code: number; stdout: string; stderr: string }
/** Runs a program and waits for it. Injectable: the tests pass a stand-in, CI has no whisper. */
export type Runner = (exe: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>;

/** The real runner: a hidden child process, dropped to below-normal priority as soon as it starts. */
export const spawnBelowNormal: Runner = (exe, args, opts) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { cwd: opts.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  try { if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* priority is a courtesy, not a requirement */ }
  const out: Buffer[] = [], err: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => out.push(d));
  child.stderr.on("data", (d: Buffer) => { err.push(d); if (err.length > 2000) err.splice(0, 1000); });
  const timer = setTimeout(() => { child.kill(); reject(new Error(`whisper didn't finish within ${Math.round(opts.timeoutMs / 60000)} minutes and was stopped`)); }, opts.timeoutMs);
  child.on("error", (e) => { clearTimeout(timer); reject(e); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }); });
});

/** Languages: "auto" (whisper detects it) or a two- or three-letter code, e.g. en, sw. */
export function languageProblem(language: string): string | undefined {
  return /^(auto|[a-z]{2,3})$/.test(language) ? undefined : `Language "${language}" must be auto or a code such as en or sw`;
}

/** The arguments for whisper-cli: no timestamps, a JSON result next to the audio's temp copy (it holds the language). */
export function whisperArgs(q: { model: string; wav: string; language: string; outBase: string; threads: number }): string[] {
  return ["-m", q.model, "-f", q.wav, "-l", q.language, "-t", String(q.threads), "-nt", "-oj", "-of", q.outBase];
}

export interface Transcript { text: string; language: string; model: WhisperModel; transcribed_by: string; seconds: number }

/** The words from whisper's JSON result, or from its printed lines when the JSON is missing. */
export function readTranscript(json: string | undefined, stdout: string, stderr = ""): { text: string; language: string } {
  if (json) {
    try {
      const j = JSON.parse(json) as { result?: { language?: string }; transcription?: Array<{ text?: string }> };
      return { text: tidy((j.transcription ?? []).map((s) => s.text ?? "").join(" ")), language: j.result?.language ?? "" };
    } catch { /* fall back to the printed lines */ }
  }
  const lines = stdout.split(/\r?\n/).filter((l) => !/^\s*(auto-detected language|whisper_|main:|system_info)/.test(l)).map((l) => l.replace(/^\s*\[[^\]]*-->[^\]]*\]\s*/, ""));
  return { text: tidy(lines.join(" ")), language: /auto-detected language:\s*([a-z]{2,3})/.exec(stderr + "\n" + stdout)?.[1] ?? "" };
}

const tidy = (s: string) => s.replace(/\[(BLANK_AUDIO|MUSIC|NOISE)\]/gi, " ").replace(/\s+/g, " ").trim();

/**
 * Transcribes one 16 kHz mono WAV. The audio is copied to a temp folder first, so whisper's output never lands beside the
 * register and a path with odd characters can't trip the tool.
 */
export async function transcribe(q: { wav: string; model?: WhisperModel; language?: string; home?: string; run?: Runner; timeoutMs?: number; threads?: number }): Promise<Transcript> {
  const model = q.model ?? "small", language = (q.language ?? "auto").trim().toLowerCase() || "auto";
  const lp = languageProblem(language);
  if (lp) throw new Error(lp);
  const problems = wavFileProblems(q.wav);
  if (problems.length) throw new Error(problems.join("; "));
  const home = q.home ?? whisperHome();
  const st = whisperStatus(home, model);
  if (!st.cli.installed) throw new Error(`Whisper isn't installed (no ${st.cli.path}): run fmc_review whisper_setup, then dry_run=false to download it`);
  if (!st.models.find((m) => m.model === model)!.installed) throw new Error(`The ${model} model isn't downloaded (${whisperPaths(home, model).model}): run fmc_review whisper_setup with model=${model}, then dry_run=false`);
  const work = fs.mkdtempSync(win.join(os.tmpdir(), "fmc-whisper-"));
  try {
    const wav = win.join(work, "note.wav"), outBase = win.join(work, "note");
    fs.copyFileSync(q.wav, wav);
    const threads = q.threads ?? Math.max(1, Math.min(8, os.cpus().length - 1));
    const started = Date.now();
    const r = await (q.run ?? spawnBelowNormal)(st.cli.path, whisperArgs({ model: whisperPaths(home, model).model, wav, language, outBase, threads }),
      { cwd: whisperPaths(home).bin, timeoutMs: q.timeoutMs ?? 15 * 60000 });
    if (r.code !== 0) throw new Error(`whisper stopped with code ${r.code}: ${r.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || "no message"}`);
    let json: string | undefined;
    try { json = fs.readFileSync(outBase + ".json", "utf8"); } catch { json = undefined; }
    const t = readTranscript(json, r.stdout, r.stderr);
    return { text: t.text, language: t.language || (language === "auto" ? "" : language), model, transcribed_by: `whisper ${model} (offline)`, seconds: Math.round((Date.now() - started) / 100) / 10 };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp files go with the next clean-up */ }
  }
}

// ---------------------------------------------------------------------------------------------------------- the setup

/** Downloads a URL to a file and returns its SHA-256. Injectable for the tests. */
export type Downloader = (url: string, dest: string) => Promise<{ sha256: string; bytes: number }>;

/** The real downloader: streams to <dest>.part while hashing, then renames, so a broken download never looks finished. */
export const httpDownload: Downloader = async (url, dest) => {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed: ${url} answered ${res.status}`);
  const part = dest + ".part";
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(part);
  let bytes = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      bytes += value.length;
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
  } finally {
    await new Promise<void>((r) => out.end(r));
  }
  fs.renameSync(part, dest);
  return { sha256: hash.digest("hex"), bytes };
};

export interface SetupPlan { home: string; steps: Array<{ what: string; url: string; to: string; mb: number }>; status: WhisperStatus }

/** What whisper_setup would download (nothing when everything is in place). */
export function setupPlan(home: string, model: WhisperModel): SetupPlan {
  const status = whisperStatus(home, model), p = whisperPaths(home, model);
  const steps: SetupPlan["steps"] = [];
  if (!status.cli.installed) steps.push({ what: `whisper.cpp ${WHISPER_DOWNLOADS.bin.version} for Windows x64`, url: WHISPER_DOWNLOADS.bin.url, to: p.bin, mb: Math.round(WHISPER_DOWNLOADS.bin.bytes / 1e6) });
  if (!status.models.find((m) => m.model === model)!.installed) steps.push({ what: `the ${model} model`, url: WHISPER_DOWNLOADS.models[model].url, to: p.model, mb: Math.round(WHISPER_DOWNLOADS.models[model].bytes / 1e6) });
  return { home, steps, status };
}

/** Runs the plan: downloads, checks each SHA-256 against the published one, unpacks the tool. A mismatch keeps nothing. */
export async function runSetup(home: string, model: WhisperModel, download: Downloader = httpDownload): Promise<{ done: string[]; status: WhisperStatus }> {
  const plan = setupPlan(home, model), p = whisperPaths(home, model), done: string[] = [];
  fs.mkdirSync(p.bin, { recursive: true });
  fs.mkdirSync(p.models, { recursive: true });
  for (const s of plan.steps) {
    if (s.url === WHISPER_DOWNLOADS.bin.url) {
      const zipFile = win.join(home, "whisper-bin-x64.zip");
      const d = await download(s.url, zipFile);
      if (d.sha256 !== WHISPER_DOWNLOADS.bin.sha256) { fs.rmSync(zipFile, { force: true }); throw new Error(`whisper.cpp download didn't match its published SHA-256 (got ${d.sha256}); nothing was installed`); }
      // only the transcriber and its libraries: the release also carries demos and tests we don't need
      const entries = readZip(fs.readFileSync(zipFile));
      let n = 0;
      for (const [name, data] of entries) {
        const base = name.split("/").pop() ?? "";
        if (base.toLowerCase() === "whisper-cli.exe" || base.toLowerCase().endsWith(".dll")) { fs.writeFileSync(win.join(p.bin, base), data); n++; }
      }
      fs.rmSync(zipFile, { force: true });
      if (!fs.existsSync(p.cli)) throw new Error("The whisper.cpp release has no whisper-cli.exe: the release layout changed; update WHISPER_DOWNLOADS");
      fs.writeFileSync(win.join(p.bin, "VERSION.txt"), WHISPER_DOWNLOADS.bin.version + "\n");
      done.push(`whisper.cpp ${WHISPER_DOWNLOADS.bin.version} (${n} files) in ${p.bin}`);
    } else {
      const d = await download(s.url, p.model);
      if (d.sha256 !== WHISPER_DOWNLOADS.models[model].sha256) { fs.rmSync(p.model, { force: true }); throw new Error(`The ${model} model didn't match its published SHA-256 (got ${d.sha256}); it was deleted, try again`); }
      fs.writeFileSync(p.model + ".verified", d.sha256 + "\n");
      done.push(`the ${model} model (${Math.round(d.bytes / 1e6)} MB, SHA-256 checked) in ${p.models}`);
    }
  }
  return { done, status: whisperStatus(home, model) };
}

/** A 16 kHz mono 16-bit WAV of the given samples (the pane writes the same header); used by the tests. */
export function wavBytes(samples: Int16Array, rate = 16000, channels = 1): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii"); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
