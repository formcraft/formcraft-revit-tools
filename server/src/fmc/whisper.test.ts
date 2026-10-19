import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Downloader, Runner, WHISPER_DOWNLOADS, readTranscript, readWavHeader, runSetup, setupPlan, transcribe, wavBytes, wavProblems, whisperArgs, whisperHome, whisperPaths, whisperStatus } from "./whisper.js";
import { writeZip } from "./zip.js";

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `fmc-${name}-`));
const tone = (seconds: number, rate = 16000, channels = 1) => {
  const s = new Int16Array(Math.round(seconds * rate) * channels);
  for (let i = 0; i < s.length; i++) s[i] = Math.round(Math.sin(i / 8) * 8000);
  return s;
};

/** A whisper home with a stand-in tool and a verified small model (no real whisper on CI). */
function installedHome(): string {
  const home = tmp("whisper");
  const p = whisperPaths(home, "small");
  fs.mkdirSync(p.bin, { recursive: true });
  fs.mkdirSync(p.models, { recursive: true });
  fs.writeFileSync(p.cli, "stand-in");
  fs.writeFileSync(p.model, "stand-in model");
  fs.writeFileSync(p.model + ".verified", WHISPER_DOWNLOADS.models.small.sha256);
  return home;
}

/** A stand-in whisper-cli: records its call and writes the JSON result whisper writes with -oj -of. */
function standIn(text: string, language = "en", code = 0): { run: Runner; calls: Array<{ exe: string; args: string[] }> } {
  const calls: Array<{ exe: string; args: string[] }> = [];
  const run: Runner = async (exe, args) => {
    calls.push({ exe, args });
    const of = args[args.indexOf("-of") + 1];
    if (code === 0) fs.writeFileSync(of + ".json", JSON.stringify({ result: { language }, transcription: [{ text: " " + text.split(". ")[0] + "." }, { text: " " + text.split(". ").slice(1).join(". ") }] }));
    return { code, stdout: "", stderr: code ? "error: failed to read WAV file" : "" };
  };
  return { run, calls };
}

test("whisper: the home is %LOCALAPPDATA%\\Formcraft\\whisper, with bin and models", () => {
  assert.equal(whisperHome({ LOCALAPPDATA: "C:\\Users\\A\\AppData\\Local" }), "C:\\Users\\A\\AppData\\Local\\Formcraft\\whisper");
  assert.equal(whisperHome({ FMC_WHISPER_DIR: "D:\\w", LOCALAPPDATA: "C:\\x" }), "D:\\w");
  const p = whisperPaths("C:\\L\\Formcraft\\whisper", "medium");
  assert.equal(p.cli, "C:\\L\\Formcraft\\whisper\\bin\\whisper-cli.exe");
  assert.equal(p.model, "C:\\L\\Formcraft\\whisper\\models\\ggml-medium.bin");
});

test("whisper: every download is pinned and carries its published SHA-256", () => {
  assert.match(WHISPER_DOWNLOADS.bin.url, /^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/v[\d.]+\/whisper-bin-x64\.zip$/);
  for (const m of Object.values(WHISPER_DOWNLOADS.models)) {
    assert.match(m.url, /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/[0-9a-f]{40}\/ggml-(small|medium)\.bin$/, "pinned to a commit, not main");
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
  }
  assert.match(WHISPER_DOWNLOADS.bin.sha256, /^[0-9a-f]{64}$/);
});

test("whisper: 16 kHz mono 16-bit WAV passes; anything else is refused with the reason", () => {
  const good = readWavHeader(wavBytes(tone(1)));
  assert.equal(typeof good, "object");
  assert.deepEqual(good, { format: 1, channels: 1, sample_rate: 16000, bits: 16, data_bytes: 32000, seconds: 1 });
  assert.deepEqual(wavProblems(good), []);
  const cd = wavProblems(readWavHeader(wavBytes(tone(1, 44100, 2), 44100, 2)));
  assert.equal(cd.length, 1);
  assert.match(cd[0], /44100 Hz, not 16000 Hz; it has 2 channels, not 1/);
  assert.match(cd[0], /16 kHz mono 16-bit WAV/);
  assert.match(wavProblems(readWavHeader(Buffer.from("OggS\0\0\0\0\0\0\0\0opus")))[0], /isn't a WAV file/);
  assert.match(wavProblems(readWavHeader(wavBytes(new Int16Array(10))))[0], /shorter than a tenth/);
});

test("whisper: the call is the small model, auto language, no timestamps, a JSON result", () => {
  assert.deepEqual(whisperArgs({ model: "m.bin", wav: "a.wav", language: "auto", outBase: "o", threads: 3 }),
    ["-m", "m.bin", "-f", "a.wav", "-l", "auto", "-t", "3", "-nt", "-oj", "-of", "o"]);
  assert.deepEqual(readTranscript(JSON.stringify({ result: { language: "sw" }, transcription: [{ text: " Mlango ni mdogo." }, { text: " [BLANK_AUDIO]" }] }), ""),
    { text: "Mlango ni mdogo.", language: "sw" });
  assert.deepEqual(readTranscript(undefined, "\n[00:00:00.000 --> 00:00:02.000]   Make it 1200 wide.\n", "whisper_full: auto-detected language: en (p = 0.97)\n"),
    { text: "Make it 1200 wide.", language: "en" });
});

test("whisper: transcribe runs the stand-in on a temp copy and labels the result offline", async () => {
  const home = installedHome(), dir = tmp("note");
  const wav = path.join(dir, "note-1.wav");
  fs.writeFileSync(wav, wavBytes(tone(1.5)));
  const s = standIn("Make the door 1026 wide. The frame hits the column");
  const t = await transcribe({ wav, home, run: s.run, threads: 2 });
  assert.equal(t.text, "Make the door 1026 wide. The frame hits the column");
  assert.equal(t.language, "en");
  assert.equal(t.transcribed_by, "whisper small (offline)");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].exe, whisperPaths(home).cli);
  assert.equal(s.calls[0].args[1], whisperPaths(home, "small").model);
  assert.equal(s.calls[0].args[5], "auto");
  assert.notEqual(s.calls[0].args[3], wav, "whisper reads a temp copy, never the register's file");
  assert.ok(!fs.existsSync(path.dirname(s.calls[0].args[3])), "the temp folder is cleaned up");
  assert.deepEqual(fs.readdirSync(dir), ["note-1.wav"], "nothing is written beside the audio");
});

test("whisper: transcribe refuses bad audio, a missing model and a bad language before running anything; a failed run says why", async () => {
  const home = installedHome(), dir = tmp("note");
  const s = standIn("x");
  const cd = path.join(dir, "cd.wav");
  fs.writeFileSync(cd, wavBytes(tone(0.5, 44100, 2), 44100, 2));
  await assert.rejects(transcribe({ wav: cd, home, run: s.run }), /44100 Hz/);
  const wav = path.join(dir, "ok.wav");
  fs.writeFileSync(wav, wavBytes(tone(0.5)));
  await assert.rejects(transcribe({ wav, home, run: s.run, model: "medium" }), /medium model isn't downloaded.*whisper_setup/);
  await assert.rejects(transcribe({ wav, home: tmp("empty"), run: s.run }), /Whisper isn't installed/);
  await assert.rejects(transcribe({ wav, home, run: s.run, language: "english please" }), /must be auto or a code/);
  assert.equal(s.calls.length, 0);
  await assert.rejects(transcribe({ wav, home, run: standIn("x", "en", 3).run }), /code 3: error: failed to read WAV file/);
});

test("whisper_setup: plans what is missing, verifies each SHA-256, unpacks only the tool and its DLLs; a mismatch keeps nothing", async () => {
  const home = tmp("setup");
  const plan = setupPlan(home, "small");
  assert.deepEqual(plan.steps.map((s) => s.url), [WHISPER_DOWNLOADS.bin.url, WHISPER_DOWNLOADS.models.small.url]);
  assert.equal(plan.status.ready, false);
  const zip = writeZip([{ name: "Release/whisper-cli.exe", data: "exe" }, { name: "Release/whisper.dll", data: "dll" }, { name: "Release/ggml-base.dll", data: "dll" }, { name: "Release/bench.exe", data: "demo" }]);
  const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

  const bad: Downloader = async (url, dest) => { fs.writeFileSync(dest, url.endsWith(".zip") ? zip : "model"); return { sha256: sha("tampered"), bytes: 5 }; };
  await assert.rejects(runSetup(home, "small", bad), /didn't match its published SHA-256/);
  assert.equal(fs.existsSync(whisperPaths(home).cli), false);
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith(".zip")), [], "the bad zip is deleted");

  // a downloader that delivers the published files (a stand-in for the network: it reports the published digests)
  const urls: string[] = [];
  const good: Downloader = async (url, dest) => {
    urls.push(url);
    fs.writeFileSync(dest, url.endsWith(".zip") ? zip : "model");
    return { sha256: url.endsWith(".zip") ? WHISPER_DOWNLOADS.bin.sha256 : WHISPER_DOWNLOADS.models.small.sha256, bytes: 5 };
  };
  const r = await runSetup(home, "small", good);
  assert.equal(r.status.ready, true);
  assert.equal(r.status.cli.version, WHISPER_DOWNLOADS.bin.version);
  assert.deepEqual(fs.readdirSync(whisperPaths(home).bin).sort(), ["VERSION.txt", "ggml-base.dll", "whisper-cli.exe", "whisper.dll"]);
  assert.equal(setupPlan(home, "small").steps.length, 0, "a second run downloads nothing");
  assert.deepEqual(setupPlan(home, "medium").steps.map((s) => s.url), [WHISPER_DOWNLOADS.models.medium.url], "medium needs only its model");
  assert.equal(whisperStatus(home, "medium").ready, false);
});

test("fmc_review transcribe: a voice reply on a ticket gets its transcript; a voice-only mark gets its title", async () => {
  const dir = tmp("review");
  const project = path.join(dir, "Projects", "F26001");
  fs.mkdirSync(path.join(project, "01_WIP"), { recursive: true });
  const guard = path.join(dir, "fmc_guard.json");
  fs.writeFileSync(guard, JSON.stringify({ write_roots: [path.join(dir, "Projects", "*", "01_WIP")], reports_dir: path.join(dir, "reports") }));
  const wav = path.join(dir, "rec.wav");
  fs.writeFileSync(wav, wavBytes(tone(1)));
  const old = process.env.FMC_GUARD_CONFIG;
  process.env.FMC_GUARD_CONFIG = guard;
  try {
    const { runFmcReview, FMC_REVIEW_SHAPE } = await import("../tools/fmc_review.js");
    const { z } = await import("zod");
    const schema = z.object(FMC_REVIEW_SHAPE);
    const home = installedHome();
    const s = standIn("Raise the ceiling to 2700. It is too low over the bed");
    const call = async (a: object) => { const r = await runFmcReview(schema.parse(a), { run: s.run, whisperHome: home }); return { body: JSON.parse(r.content[0].text), isError: r.isError }; };

    const m = await call({ action: "mark", project_folder: project, project_code: "F26001", to: "ai", audio: wav, where: { unique_ids: ["u-1"] }, by: "Owner" });
    assert.equal(m.isError, false, JSON.stringify(m.body));
    assert.equal(m.body.item.title, "Voice note");
    const id = m.body.item.id;

    const t = await call({ action: "transcribe", project_folder: project, id, by: "Owner" });
    assert.equal(t.isError, false, JSON.stringify(t.body));
    assert.equal(t.body.item.notes[0].transcript, "Raise the ceiling to 2700. It is too low over the bed");
    assert.equal(t.body.item.notes[0].transcribed_by, "whisper small (offline)");
    assert.equal(t.body.item.title, "Raise the ceiling to 2700.");
    assert.equal(s.calls[0].args[3].endsWith("note.wav"), true);

    const c = await call({ action: "comment", project_folder: project, id, audio: wav, by: "Site" });
    assert.equal(c.body.item.notes.length, 2);
    const t2 = await call({ action: "transcribe", project_folder: project, id, note: 2, language: "en", by: "Site" });
    assert.equal(t2.body.item.notes[1].transcript.length > 0, true);
    assert.equal(s.calls[1].args[5], "en");

    const typed = await call({ action: "comment", project_folder: project, id, text: "Done in the next model", by: "AI" });
    assert.equal(typed.isError, false);
    const no = await call({ action: "transcribe", project_folder: project, id, note: 3 });
    assert.equal(no.isError, true);
    assert.match(no.body.reasons[0], /typed, not a voice note/);

    const q = await call({ action: "queue", project_folder: project, to: "ai" });
    assert.equal(q.body.tickets[0].voice, true);

    const bare = await call({ action: "transcribe", audio: wav, model: "small" });
    assert.equal(bare.body.done, true, "a bare audio file needs no project");
    assert.equal(bare.body.transcribed_by, "whisper small (offline)");

    const setup = await call({ action: "whisper_setup", model: "medium" });
    assert.equal(setup.body.dry_run, true, "setup is a dry run unless dry_run=false");
    assert.equal(setup.body.would_download.length, 1);
  } finally {
    if (old === undefined) delete process.env.FMC_GUARD_CONFIG; else process.env.FMC_GUARD_CONFIG = old;
  }
});
