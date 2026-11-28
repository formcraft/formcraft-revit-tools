/**
 * JAIL tests (project-folder gate core): traversal, junction and symlink escape, UNC, 8.3 short names, case, the
 * sibling-prefix trick, device and stream paths, read_only_roots, the shared-state (LOCALAPPDATA) write refusal,
 * workshared roots, unsaved documents and the forbidden-project floor. Real folders under the temp folder; nothing
 * outside it is created, read or written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { JAIL, JailFs, canonical, jail, jailCheck, jailDocumentOf, jailForbiddenProject, jailRoots } from "./jail.js";
import { DEFAULT_CONFIG, checkWritePath } from "./policy.js";

const win = path.win32;
const base = fs.realpathSync.native(fs.mkdtempSync(win.join(os.tmpdir(), "fmc-jail-")));
const proj = win.join(base, "Proj");
const proj2 = win.join(base, "Proj2");
const outside = win.join(base, "Outside");
const kit = win.join(base, "Kit");
const local = win.join(base, "LocalAppData");
const roaming = win.join(base, "Roaming");
for (const d of [win.join(proj, "01_WIP", "A"), win.join(proj2, "01_WIP"), outside, win.join(kit, "03_Master_Data"), win.join(local, "Formcraft", "leases"), win.join(roaming, "Formcraft")])
  fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(win.join(proj, "01_WIP", "A", "model.rvt"), "x");
fs.writeFileSync(win.join(outside, "secret.txt"), "x");
fs.writeFileSync(win.join(kit, "03_Master_Data", "FMC_Codes.csv"), "x");

const env = { ...process.env, LOCALAPPDATA: local, APPDATA: roaming };
const cfg = { ...DEFAULT_CONFIG, read_only_roots: [kit], write_roots: [] as string[] };
const doc = { title: "model.rvt", path: win.join(proj, "01_WIP", "A", "model.rvt"), isWorkshared: false };
const roots = () => jailRoots(doc, cfg, { env, bundled: [] });
const check = (kind: "read" | "write" | "list" | "open", p: string) => jailCheck(kind, p, roots(), cfg, { env });

test.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* temp */ } });

test("JAIL inside the project folder: read and write allowed; the project root is the folder above 01_WIP", () => {
  assert.equal(check("write", win.join(proj, "01_WIP", "A", "out.csv")).ok, true);
  assert.equal(check("read", win.join(proj, "06_QA", "x.csv")).ok, true);
  assert.equal(roots().docRoots[0].path.toLowerCase(), proj.toLowerCase());
});

test("JAIL ..\\ traversal out of the project is refused (read and write)", () => {
  const p = win.join(proj, "01_WIP") + "\\..\\..\\Outside\\secret.txt";
  for (const k of ["read", "write"] as const) {
    const v = check(k, p);
    assert.equal(v.ok, false); assert.equal(v.code, JAIL.OUTSIDE);
    assert.match(v.message, /Outside\\secret\.txt/i);
  }
  assert.equal(check("read", win.join(proj, "01_WIP", "..", "06_QA", "x.csv")).ok, true, ".. that stays inside is fine");
});

test("JAIL sibling-prefix trick: D:\\Proj2 is not inside D:\\Proj", () => {
  const v = check("write", win.join(proj2, "01_WIP", "x.csv"));
  assert.equal(v.ok, false); assert.equal(v.code, JAIL.OUTSIDE);
  assert.equal(check("read", proj + "2\\01_WIP\\x.csv").ok, false);
});

test("JAIL case does not matter for the compare", () => {
  assert.equal(check("write", proj.toUpperCase() + "\\01_wip\\a\\OUT.CSV").ok, true);
  assert.equal(check("write", outside.toUpperCase() + "\\X.CSV").ok, false);
});

test("JAIL junction escape: a junction inside the project that points outside is refused", () => {
  const link = win.join(proj, "01_WIP", "jlink");
  fs.symlinkSync(outside, link, "junction");
  const v = check("read", win.join(link, "secret.txt"));
  assert.equal(v.ok, false); assert.equal(v.code, JAIL.OUTSIDE);
  assert.match(String(v.resolved), /Outside/i);
  assert.equal(check("write", win.join(link, "new", "deeper.txt")).ok, false, "not-yet-existing tail under the junction");
  fs.unlinkSync(link);
});

test("JAIL junction made after the roots were taken is still refused at IO time (TOCTOU)", () => {
  const r = roots();
  const link = win.join(proj, "01_WIP", "late");
  fs.symlinkSync(outside, link, "junction");
  assert.throws(() => jail.writeText(win.join(link, "planted.txt"), "x", r, cfg), /FMC-JAIL-OUTSIDE/);
  assert.equal(fs.existsSync(win.join(outside, "planted.txt")), false);
  fs.unlinkSync(link);
});

test("JAIL symlink escape (file or folder symlink) is refused, when this PC lets a test make one", (t) => {
  const link = win.join(proj, "01_WIP", "slink");
  try { fs.symlinkSync(outside, link, "dir"); } catch { t.skip("symlinks need Developer Mode or admin here"); return; }
  const v = check("read", win.join(link, "secret.txt"));
  assert.equal(v.ok, false); assert.equal(v.code, JAIL.OUTSIDE);
  fs.unlinkSync(link);
});

test("JAIL 8.3 short names resolve to the long name before the compare", (t) => {
  const longOut = win.join(base, "Outside Folder Long Name");
  fs.mkdirSync(longOut, { recursive: true });
  fs.writeFileSync(win.join(longOut, "f.txt"), "x");
  let short = "";
  try { short = execSync(`for %I in ("${longOut}") do @echo %~sI`, { encoding: "utf8", shell: "cmd.exe" }).trim(); } catch { /* none */ }
  if (!short || short.toLowerCase() === longOut.toLowerCase() || !/~\d/.test(short)) { t.skip("8.3 names are off on this volume"); return; }
  const v = check("read", win.join(short, "f.txt"));
  assert.equal(v.ok, false); assert.equal(v.code, JAIL.OUTSIDE);
  assert.match(String(v.resolved), /Outside Folder Long Name/i);
});

test("JAIL an 8.3-looking name in a part that does not exist is refused", () => {
  const v = check("write", win.join(proj, "01_WIP", "PROJEC~1", "x.txt"));
  assert.equal(v.ok, false); assert.equal(v.code, JAIL.BADPATH);
});

test("JAIL UNC: an admin share of this PC is the drive path; another server is outside; \\\\?\\ and \\\\.\\ are refused", () => {
  const fake: JailFs = { exists: () => false, realpath: (p) => p };
  const r = jailRoots({ title: "m", path: "C:\\Jobs\\P1\\01_WIP\\m.rvt" }, { read_only_roots: [] }, { jfs: fake, env, bundled: [] });
  const c = (p: string, k: "read" | "write" = "write") => jailCheck(k, p, r, {}, { jfs: fake, env });
  assert.equal(c("\\\\localhost\\C$\\Jobs\\P1\\01_WIP\\a.txt").ok, true);
  assert.equal(c("\\\\127.0.0.1\\c$\\Jobs\\P1\\x.txt").ok, true);
  assert.equal(c("\\\\localhost\\C$\\Jobs\\P2\\x.txt").code, JAIL.OUTSIDE);
  assert.equal(c("\\\\fileserver\\share\\Jobs\\P1\\x.txt").code, JAIL.OUTSIDE);
  assert.equal(c("\\\\?\\C:\\Jobs\\P1\\x.txt").code, JAIL.BADPATH);
  assert.equal(c("\\\\.\\C:\\Jobs\\P1\\x.txt").code, JAIL.BADPATH);
  assert.equal(c("//localhost/C$/Jobs/P1/01_WIP/b.txt").ok, true, "forward slashes are the same path");
});

test("JAIL device names, streams, NUL, wildcards, trailing dots, relative paths and unset variables are refused", () => {
  const w = win.join(proj, "01_WIP");
  for (const p of [w + "\\a.txt:hidden", w + "\\NUL.txt", w + "\\con", w + "\\a\0b", w + "\\*.rvt", w + "\\name.", w + "\\name ", "01_WIP\\a.txt", "..\\x", "%NOPE_NOT_SET%\\x"])
    assert.equal(check("write", p).code, JAIL.BADPATH, p);
});

test("JAIL %LOCALAPPDATA%\\Formcraft (and %APPDATA%\\Formcraft): the AI may read, never write", () => {
  const lease = win.join(local, "Formcraft", "leases", "lease.json");
  const v = check("write", lease);
  assert.equal(v.ok, false); assert.equal(v.code, JAIL.SHARED);
  assert.equal(check("write", "%LOCALAPPDATA%\\Formcraft\\token.txt").code, JAIL.SHARED);
  assert.equal(check("write", win.join(roaming, "Formcraft", "fmc_guard.json")).code, JAIL.SHARED);
  assert.equal(check("read", lease).ok, true);
  assert.equal(check("list", win.join(local, "Formcraft")).ok, true);
  assert.equal(check("write", win.join(local, "FormcraftX", "a.txt")).code, JAIL.OUTSIDE, "a sibling-prefix of the shared folder is not shared");
});

test("JAIL read_only_roots: read, list and open allowed; write always refused, even inside the project", () => {
  assert.equal(check("read", win.join(kit, "03_Master_Data", "FMC_Codes.csv")).ok, true);
  assert.equal(check("open", win.join(kit, "03_Master_Data", "FMC_Codes.csv")).ok, true);
  assert.equal(check("write", win.join(kit, "04_Families", "_Staging", "x.rfa")).code, JAIL.READONLY);
  const nested = { ...cfg, read_only_roots: [win.join(proj, "00_Kit")] };
  assert.equal(jailCheck("write", win.join(proj, "00_Kit", "a.txt"), jailRoots(doc, nested, { env, bundled: [] }), nested, { env }).code, JAIL.READONLY);
});

test("JAIL workshared: the central's folder plus the local file, its _backup folder and .NNNN backups; the rest of Documents is out", () => {
  const share = win.join(base, "WORKSHARE", "PROJECT");
  const docs = win.join(base, "Documents");
  fs.mkdirSync(share, { recursive: true }); fs.mkdirSync(win.join(docs, "plumbing_USER_backup"), { recursive: true });
  const ws = { title: "plumbing_USER", path: win.join(docs, "plumbing_USER.rvt"), isWorkshared: true, centralPath: win.join(share, "plumbing.rvt") };
  const r = jailRoots(ws, cfg, { env, bundled: [] });
  const c = (p: string, k: "read" | "write" = "write") => jailCheck(k, p, r, cfg, { env });
  assert.equal(c(win.join(share, "links", "x.rvt"), "read").ok, true);
  assert.equal(c(ws.path).ok, true);
  assert.equal(c(win.join(docs, "plumbing_USER_backup", "incrementtable.dat")).ok, true);
  assert.equal(c(win.join(docs, "plumbing_USER.0003.rvt")).ok, true);
  assert.equal(c(win.join(docs, "electrical_USER.rvt"), "read").code, JAIL.OUTSIDE, "a sibling local is another document's jail");
  assert.equal(c(win.join(docs, "notes.txt"), "read").code, JAIL.OUTSIDE);
  assert.equal(c(win.join(docs, "plumbing_USER.0003.rvt.txt")).code, JAIL.OUTSIDE);
  const noCentral = jailRoots({ ...ws, centralPath: undefined }, cfg, { env, bundled: [] });
  assert.equal(jailCheck("read", win.join(share, "x.rvt"), noCentral, cfg, { env }).ok, false, "unknown central: narrower, not wider");
});

test("JAIL an unsaved document has no root: every write is refused; a saved model without 01_WIP gets only its file", () => {
  const r = jailRoots({ title: "Project1", path: "" }, cfg, { env, bundled: [] });
  assert.equal(jailCheck("write", win.join(proj, "01_WIP", "x.txt"), r, cfg, { env }).code, JAIL.NOROOT);
  const loose = jailRoots({ title: "m", path: win.join(outside, "m.rvt") }, cfg, { env, bundled: [] });
  assert.equal(jailCheck("write", win.join(outside, "m.rvt"), loose, cfg, { env }).ok, true);
  assert.equal(jailCheck("read", win.join(outside, "secret.txt"), loose, cfg, { env }).ok, false);
});

test("JAIL forbidden-project floor (RV-6): A-0001 and HEBERT HOSTELS are never written, even inside the jail", () => {
  const hp = win.join(base, "HEBERT HOSTELS", "01_WIP", "HEBERT HOSTELS_USER.rvt");
  const r = jailRoots({ title: "HEBERT HOSTELS_USER", path: hp }, cfg, { env, bundled: [] });
  assert.equal(jailCheck("write", hp, r, cfg, { env }).code, JAIL.FORBIDDEN);
  assert.equal(jailForbiddenProject("D:\\X\\A-0001-Legacy\\m.rvt"), "A-0001");
  assert.equal(jailForbiddenProject("D:\\X\\F1-ORG-ZZ-00-M3-A-0001.rvt"), null, "role-number field is not the project");
  assert.equal(jailForbiddenProject("D:\\X\\NEW CLIENT\\m.rvt", { forbidden_projects: ["New Client"] }), "New Client");
});

test("JAIL protected_roots from the guard file refuse writes inside the jail (RV-6: empty protects nothing)", () => {
  const p = { ...cfg, protected_roots: [win.join(proj, "01_WIP", "A")] };
  assert.equal(jailCheck("write", win.join(proj, "01_WIP", "A", "x.txt"), jailRoots(doc, p, { env, bundled: [] }), p, { env }).code, JAIL.PROTECTED);
  assert.equal(check("write", win.join(proj, "01_WIP", "A", "x.txt")).ok, true);
});

test("JAIL the call's document: named, the only one, or none when two are open and none is named", () => {
  const open = [{ title: "a", path: "C:\\P\\01_WIP\\a.rvt" }, { title: "b", path: "C:\\Q\\01_WIP\\b.rvt" }];
  assert.equal(jailDocumentOf(open, "b")?.doc?.path, "C:\\Q\\01_WIP\\b.rvt");
  assert.equal(jailDocumentOf(open, undefined).doc, null);
  assert.equal(jailDocumentOf([open[0]], undefined).doc?.path, "C:\\P\\01_WIP\\a.rvt");
  assert.equal(jailDocumentOf(open, "zzz").doc, null);
});

test("JAIL canonical: env vars expand, slashes turn, case kept for display", () => {
  const c = canonical("%LOCALAPPDATA%/Formcraft/leases", undefined, env);
  assert.equal(c.ok, true);
  assert.equal(c.path.toLowerCase(), win.join(local, "Formcraft", "leases").toLowerCase());
});

test("JAIL checkWritePath refuses read_only_roots and shared state even when write_roots allows them", () => {
  const prev = { L: process.env.LOCALAPPDATA, A: process.env.APPDATA };
  process.env.LOCALAPPDATA = local; process.env.APPDATA = roaming;
  try {
    const wide = { ...DEFAULT_CONFIG, write_roots: [base], read_only_roots: [kit] };
    const k = checkWritePath(win.join(kit, "04_Families", "_Staging", "A", "x.rfa"), wide, { checkName: false });
    assert.equal(k.ok, false); assert.ok(k.reasons.some((r) => r.includes("FMC-JAIL-READONLY")));
    const s = checkWritePath(win.join(local, "Formcraft", "x.json"), wide, { checkName: false });
    assert.equal(s.ok, false); assert.ok(s.reasons.some((r) => r.includes("FMC-JAIL-SHARED")));
    assert.equal(checkWritePath(win.join(proj, "01_WIP", "x.csv"), wide, { checkName: false }).ok, true);
  } finally {
    process.env.LOCALAPPDATA = prev.L; process.env.APPDATA = prev.A;
  }
});
