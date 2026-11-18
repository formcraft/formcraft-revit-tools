/**
 * fmc_new_local: a fresh workshared local from a central, opened in place of an open local.
 * The caller never supplies code. The server builds one fixed script and sends it through send_code_to_revit.
 * Only paths and titles that passed the literal check are placed in the script, as verbatim C# strings.
 */
import fs from "node:fs";
import path from "node:path";
import { GuardConfig } from "./policy.js";
import { underAny, protectedRoots, samePath } from "./opencopy.js";
import { documentsMatch } from "./batchline.js";
import { screenScript } from "./scriptguard.js";

const win = path.win32;

/**
 * Switch, close, and the final activate go through fmc_revit_file. That command runs in its own external event
 * (FmcRevitFile), not inside send_code_to_revit. CreateNewLocal and the background open stay in one fixed script,
 * bound to the other open document.
 */
export const NEW_LOCAL_CAVEAT =
  "The switch, the close, and the final activate go through the native file command fmc_revit_file. " +
  "Step 2 is fmc_revit_file open of the other document's path, which activates it when that file is already open. " +
  "Step 3 is fmc_revit_file close of the local, save false, immediately after the switch. If the switch is refused, nothing is closed. " +
  "The old file is renamed aside (a same-volume move, never a copy and never a delete), and an existing backup is never overwritten. The target path must be gone before CreateNewLocal. The central is only read. " +
  "The new local is opened in the background with OpenAllWorksets, then fmc_revit_file open activates it. If that activate is refused, the local stays open in the background.";

export interface NewLocalInput {
  document: string;
  central: string;
  local: string;
  switch_to?: string;
  backup_suffix?: string;
  dry_run?: boolean;
}

export interface OpenDoc {
  title: string;
  path: string;
  isFamily: boolean;
  isWorkshared: boolean;
  isActive: boolean;
  isDetached?: boolean;
  isLinked?: boolean;
  centralPath?: string;
}

export interface CentralFile {
  exists: boolean;
  isWorkshared: boolean;
  /** BasicFileInfo.IsCentral. A workshared file whose CentralPath is itself also counts. */
  isCentral: boolean;
  centralPath: string;
}

export interface LeaseView {
  lease: string;
  client: string;
}

export interface QueueRun {
  client: string;
  label: string;
}

export interface PlanContext {
  cfg: GuardConfig;
  now?: Date;
  exists: (p: string) => boolean;
  docs: OpenDoc[];
  centralFile: CentralFile;
  holder?: LeaseView | null;
  caller?: { lease?: string; client: string };
  queueRunning?: QueueRun | null;
}

export interface NewLocalPlan {
  ok: boolean;
  reasons: string[];
  dry_run: boolean;
  /** True only when this plan would close a document. A dry run, and a resume of an already-closed local, are never that. */
  closes: boolean;
  /** The named document is not open. Switch and close are skipped; the local path is moved if it is still on disk. */
  resume: boolean;
  document: string;
  central: string;
  local: string;
  active: boolean;
  switch_to: string;
  /** Title passed as the script's document: the other open project, which stays open. */
  script_document: string;
  /** PathName of switch_to, from fmc_document_info. fmc_revit_file open activates that already-open file. */
  switch_path: string;
  /** The calls a real run sends, in order. Dry run lists them and sends none. */
  calls: Array<{ command: string; params: Record<string, unknown> }>;
  backup: string;
  backup_folder_from: string;
  backup_folder_to: string;
  steps: string[];
  caveat: string;
  script?: string;
}

/** A quote or a newline in a path or title would break out of the verbatim string. Reject it; do not escape it in. */
export function scriptLiteralProblem(value: string, label: string): string | null {
  if (/["\r\n\u0000]/.test(value)) {
    return `[FMC-NEW-LOCAL] ${label} contains a quote or a newline, so it is not placed in the script. Nothing was sent.`;
  }
  return null;
}

export function backupSuffix(now: Date = new Date(), given?: string): string {
  if (given != null && given.trim()) return given.trim();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `.bak-${y}${m}${d}`;
}

/** The old local file, and its Revit _backup folder when that folder exists. Never overwrites; the next name is -2, -3, ... */
export function backupNames(local: string, suffix: string, exists: (p: string) => boolean): { file: string; folderFrom: string; folderTo: string } {
  const dir = win.dirname(local);
  const fileName = win.basename(local);
  const stem = fileName.replace(/\.rvt$/i, "");
  const folderFrom = win.join(dir, `${stem}_backup`);
  const hasFolder = exists(folderFrom);
  for (let n = 1; n <= 1000; n++) {
    const extra = n === 1 ? "" : `-${n}`;
    const file = win.join(dir, fileName + suffix + extra);
    const folderTo = win.join(dir, `${stem}_backup` + suffix + extra);
    if (exists(file)) continue;
    if (hasFolder && exists(folderTo)) continue;
    return { file, folderFrom: hasFolder ? folderFrom : "", folderTo: hasFolder ? folderTo : "" };
  }
  return { file: "", folderFrom: "", folderTo: "" };
}

function blockedReason(file: string, cfg: GuardConfig): string | null {
  const segs = win.normalize(file).toLowerCase().split("\\").filter(Boolean);
  const hit = (cfg.blocked_segments ?? []).map((s) => s.toLowerCase()).filter((s) => segs.includes(s));
  if (!hit.length) return null;
  return `Writing into ${hit.join(", ")} is a CDE gate with a named approver, not a tool action (Manual 7.5)`;
}

function rvtPath(file: string, label: string): string | null {
  if (!win.isAbsolute(file)) return `${label} must be a full path: ${file}`;
  if (win.extname(file).toLowerCase() !== ".rvt") return `${label} must be a .rvt file: ${file}`;
  return null;
}

export function fileIsCentral(file: CentralFile, central: string): boolean {
  if (!file.exists || !file.isWorkshared) return false;
  if (file.isCentral) return true;
  return !!file.centralPath && samePath(file.centralPath, central);
}

export function isLocalOf(doc: OpenDoc, central: string): boolean {
  if (doc.isFamily || !doc.isWorkshared || doc.isDetached) return false;
  if (!doc.path || !doc.centralPath) return false;
  if (samePath(doc.centralPath, doc.path)) return false;
  return samePath(doc.centralPath, central);
}

function findDocs(docs: OpenDoc[], key: string): OpenDoc[] {
  const k = key.trim().toLowerCase();
  return docs.filter((d) => d.title.toLowerCase() === k || (!!d.path && samePath(d.path, key)));
}

function otherDocs(docs: OpenDoc[], target: OpenDoc): OpenDoc[] {
  return docs.filter((d) => d !== target && !!d.path);
}

/** Another open document to activate before the close, and to bind the script to. */
export function pickSwitch(docs: OpenDoc[], target: OpenDoc, requested?: string): OpenDoc | undefined {
  return pickScriptHost(otherDocs(docs, target), requested);
}

/** Any open project document the script can bind to, including when the local is already closed. */
export function pickScriptHost(docs: OpenDoc[], requested?: string): OpenDoc | undefined {
  const open = docs.filter((d) => !d.isLinked && !!d.path);
  const want = (requested ?? "").trim();
  if (want) {
    const hit = findDocs(open, want);
    return hit.length === 1 ? hit[0] : undefined;
  }
  return open.find((d) => !d.isFamily);
}

function queueHits(running: QueueRun, doc: OpenDoc, document: string): boolean {
  return documentsMatch(running.label, document) || documentsMatch(running.label, doc.title) || (!!doc.path && documentsMatch(running.label, doc.path));
}

export function planNewLocal(input: NewLocalInput, ctx: PlanContext): NewLocalPlan {
  const now = ctx.now ?? new Date();
  const dry = input.dry_run !== false;
  const document = (input.document ?? "").trim();
  const central = (input.central ?? "").trim();
  const local = (input.local ?? "").trim();
  const reasons: string[] = [];
  const literalLabels: Array<[string, string]> = [
    [document, "document"], [central, "central"], [local, "local"], [(input.switch_to ?? "").trim(), "switch_to"], [(input.backup_suffix ?? "").trim(), "backup_suffix"],
  ];
  for (const [value, label] of literalLabels) {
    if (!value) continue;
    const problem = scriptLiteralProblem(value, label);
    if (problem) reasons.push(problem);
  }
  if (!document) reasons.push("document is required: the title of the open local to replace. The active document is not used.");
  const centralPathProblem = central ? rvtPath(central, "central") : "central is required: the full path of the central .rvt";
  const localPathProblem = local ? rvtPath(local, "local") : "local is required: the full path of the new local .rvt";
  if (centralPathProblem) reasons.push(centralPathProblem);
  if (localPathProblem) reasons.push(localPathProblem);
  if (central && local && samePath(central, local)) reasons.push("central and local are the same file. Refusing to overwrite the central.");
  const suffix = backupSuffix(now, input.backup_suffix);
  if (input.backup_suffix && /[\\/]|\.\./.test(input.backup_suffix)) reasons.push("backup_suffix is a suffix on the file name, not a path.");
  const prot = protectedRoots(ctx.cfg);
  if (local && !localPathProblem && underAny(local, prot)) reasons.push(`Protected original: ${local}. Write, save, sync, reload and relinquish are refused.`);
  if (local && !localPathProblem) {
    const blocked = blockedReason(local, ctx.cfg);
    if (blocked) reasons.push(blocked);
  }
  if (central && !centralPathProblem && !ctx.exists(central)) reasons.push(`Central not found: ${central}`);
  if (central && ctx.centralFile && !ctx.centralFile.exists && !reasons.some((r) => r.startsWith("Central not found"))) reasons.push(`Central not found: ${central}`);
  if (central && ctx.centralFile?.exists && !fileIsCentral(ctx.centralFile, central)) {
    reasons.push(`${central} is not a central. BasicFileInfo must be workshared and either IsCentral or its CentralPath equal to itself.`);
  }

  const hits = document ? findDocs(ctx.docs, document) : [];
  if (hits.length > 1) reasons.push(`"${document}" matches ${hits.length} open documents. Pass the full path.`);
  const doc = hits.length === 1 ? hits[0] : undefined;
  const localExists = !!(local && !localPathProblem && ctx.exists(local));
  const centralExists = !!(central && !centralPathProblem && (ctx.exists(central) || ctx.centralFile?.exists));
  const resume = !doc && hits.length === 0 && !!document && (localExists || centralExists);
  if (document && !doc && hits.length === 0 && !resume) {
    reasons.push(`No open document is called "${document}". Resume needs the local file or the central on disk, and both paths.`);
  }
  if (doc && !isLocalOf(doc, central)) reasons.push(`${doc.title} is not a local of ${central}.`);
  if (doc?.path && local && !samePath(doc.path, local)) reasons.push(`${doc.title} is open at ${doc.path}, not at ${local}.`);
  if (doc?.path && underAny(doc.path, prot)) reasons.push(`Protected original: ${doc.path}. Write, save, sync, reload and relinquish are refused.`);
  if (doc?.path) {
    const blocked = blockedReason(doc.path, ctx.cfg);
    if (blocked && !reasons.includes(blocked)) reasons.push(blocked);
  }

  const host = doc ? pickSwitch(ctx.docs, doc, input.switch_to) : resume ? pickScriptHost(ctx.docs, input.switch_to) : undefined;
  if ((doc || resume) && input.switch_to?.trim() && !host) reasons.push(`switch_to "${input.switch_to.trim()}" is not another open document.`);
  if ((doc || resume) && !host) {
    reasons.push(`No other open project document can take the screen before ${document} is replaced. Nothing is closed.`);
  }

  if (ctx.holder && (doc || resume) && (!ctx.caller || ctx.holder.client !== ctx.caller.client || ctx.holder.lease !== ctx.caller.lease)) {
    reasons.push(`Another lease holds ${doc?.title ?? document} (${ctx.holder.client}, ${ctx.holder.lease}).`);
  }
  if (doc && ctx.queueRunning && ctx.caller && ctx.queueRunning.client !== ctx.caller.client && queueHits(ctx.queueRunning, doc, document)) {
    reasons.push(`Another caller is running a batch on ${doc.title} (${ctx.queueRunning.client}).`);
  }

  const names = local && !localPathProblem ? backupNames(local, suffix, ctx.exists) : { file: "", folderFrom: "", folderTo: "" };
  if (local && !localPathProblem && !names.file) reasons.push("No free backup name (tried -2 through -1000). Nothing was moved.");
  for (const [value, label] of [[host?.title ?? "", "switch title"], [host?.path ?? "", "switch path"], [names.file, "backup"], [names.folderFrom, "backup folder"], [names.folderTo, "backup folder"]] as Array<[string, string]>) {
    if (!value) continue;
    const problem = scriptLiteralProblem(value, label);
    if (problem) reasons.push(problem);
  }

  const unique = [...new Set(reasons)];
  const base: NewLocalPlan = {
    ok: unique.length === 0,
    reasons: unique,
    dry_run: dry,
    closes: false,
    resume,
    document,
    central,
    local,
    active: !!doc?.isActive,
    switch_to: host?.title || (input.switch_to ?? "").trim(),
    script_document: host?.title ?? "",
    switch_path: host?.path ?? "",
    calls: [],
    backup: names.file,
    backup_folder_from: names.folderFrom,
    backup_folder_to: names.folderTo,
    steps: [],
    caveat: NEW_LOCAL_CAVEAT,
  };
  if (!base.ok || !host || (!doc && !resume)) return base;

  const moveStep = localExists
    ? `Rename ${local} to ${names.file}` + (names.folderFrom ? ` and ${names.folderFrom} to ${names.folderTo}` : "") + ". Nothing is deleted or overwritten."
    : `The local file is already gone. CreateNewLocal writes ${local}.`;
  const steps = resume
    ? [
      "resume: document is closed",
      moveStep,
      `send_code_to_revit on ${host.title}: WorksharingUtils.CreateNewLocal, then OpenDocumentFile with OpenAllWorksets.`,
      `fmc_revit_file {action:"open", path:${JSON.stringify(local)}}`,
    ]
    : [
      `Validate ${central} is a central and ${doc!.title} is a local of it.`,
      `fmc_revit_file {action:"open", path:${JSON.stringify(host.path)}}`,
      `fmc_revit_file {action:"close", title:${JSON.stringify(doc!.title)}, save:false}`,
      moveStep,
      `send_code_to_revit on ${host.title}: WorksharingUtils.CreateNewLocal, then OpenDocumentFile with OpenAllWorksets.`,
      `fmc_revit_file {action:"open", path:${JSON.stringify(local)}}`,
    ];
  let script: string | undefined;
  try {
    script = newLocalScript({ central, local });
  } catch (error) {
    return { ...base, ok: false, reasons: [error instanceof Error ? error.message : String(error)] };
  }
  const ready: NewLocalPlan = { ...base, steps, script, closes: !dry && !resume, resume, switch_path: host.path, script_document: host.title };
  return { ...ready, calls: liveCalls(ready) };
}

/** What a real run sends, in order. The script call is fmc_new_local so the fixed body is not treated as caller-supplied code. */
export function liveCalls(plan: NewLocalPlan): Array<{ command: string; params: Record<string, unknown> }> {
  const aimed = { _lease_document: plan.document, _lock_document: plan.local };
  const make = {
    command: "fmc_new_local",
    params: {
      ...aimed,
      document: plan.script_document,
      _script_document: plan.script_document,
      code: plan.script,
      parameters: [],
      usings: [],
      transactionMode: "none",
      purpose: "Fresh workshared local",
      dry_run: false,
    },
  };
  const activate = { command: "fmc_revit_file", params: { ...aimed, action: "open", path: plan.local, document: plan.script_document } };
  if (plan.resume) return [make, activate];
  return [
    { command: "fmc_revit_file", params: { ...aimed, action: "open", path: plan.switch_path, document: plan.script_document } },
    { command: "fmc_revit_file", params: { ...aimed, action: "close", title: plan.document, save: false, document: plan.script_document } },
    make,
    activate,
  ];
}

export interface ScriptFields {
  central: string;
  local: string;
}

function verbatim(value: string, label: string): string {
  const problem = scriptLiteralProblem(value, label);
  if (problem) throw new Error(problem);
  return '@"' + value + '"';
}

/** The fixed body. Callers never supply this text; only vetted strings are substituted. */
export function newLocalScript(fields: ScriptFields): string {
  const code = NEW_LOCAL_SCRIPT
    .replaceAll("__CENTRAL__", verbatim(fields.central, "central"))
    .replaceAll("__LOCAL__", verbatim(fields.local, "local"));
  if (code.includes("__")) throw new Error("[FMC-NEW-LOCAL] The script template was not filled. Nothing was sent.");
  const problem = screenScript(code);
  if (problem) throw new Error(problem.message);
  return code;
}

/**
 * Read-only facts for the plan: BasicFileInfo of the central, and whether the named document is its local.
 * transactionMode read_only. It does not close or save.
 */
export function newLocalProbeScript(central: string, document: string): string {
  const code = PROBE_SCRIPT
    .replaceAll("__CENTRAL__", verbatim(central, "central"))
    .replaceAll("__DOCUMENT__", verbatim(document, "document"));
  const problem = screenScript(code);
  if (problem) throw new Error(problem.message);
  return code;
}

/** After the gate has accepted fmc_new_local, the socket command is send_code_to_revit bound to the other document. */
export function wireNewLocal(params: Record<string, unknown>): { command: "send_code_to_revit"; params: Record<string, unknown> } {
  const scriptDoc = typeof params._script_document === "string" ? params._script_document.trim() : "";
  if (!scriptDoc) throw new Error("[FMC-NEW-LOCAL] The script has no other document to bind to. Nothing was sent.");
  const closed = typeof params._lease_document === "string" ? params._lease_document.trim() : "";
  if (closed && scriptDoc.toLowerCase() === closed.toLowerCase()) {
    throw new Error(`[FMC-NEW-LOCAL] The script must not be bound to ${closed}: that document is the local being replaced. Nothing was sent.`);
  }
  if (typeof params.code !== "string" || !params.code.trim()) throw new Error("[FMC-NEW-LOCAL] The script is missing. Nothing was sent.");
  return {
    command: "send_code_to_revit",
    params: {
      code: params.code,
      parameters: [],
      usings: [],
      transactionMode: "none",
      purpose: "Fresh workshared local",
      document: scriptDoc,
    },
  };
}

const PROBE_SCRIPT = `
string central = __CENTRAL__;
string documentKey = __DOCUMENT__;
UIApplication uiapp = new UIApplication(document.Application);
var docs = new List<object>();
Document found = null;
foreach (Document d in uiapp.Application.Documents)
{
    if (d.IsLinked) continue;
    docs.Add(new { title = d.Title, path = d.PathName ?? "", family = d.IsFamilyDocument, active = uiapp.ActiveUIDocument != null && d.Equals(uiapp.ActiveUIDocument.Document) });
    bool title = string.Equals(d.Title, documentKey, StringComparison.OrdinalIgnoreCase);
    bool byPath = false;
    try { byPath = !string.IsNullOrEmpty(d.PathName) && string.Equals(System.IO.Path.GetFullPath(d.PathName), System.IO.Path.GetFullPath(documentKey), StringComparison.OrdinalIgnoreCase); } catch (Exception) { byPath = false; }
    if (title || byPath) found = d;
}
if (!System.IO.File.Exists(central)) return new { ok = false, exists = false, docs };
var info = BasicFileInfo.Extract(central);
bool isCentral = false;
try { isCentral = info.IsCentral; } catch (Exception) { isCentral = false; }
string centralPath = info.CentralPath ?? "";
string docCentral = "";
bool docDetached = false;
if (found != null && found.IsWorkshared)
{
    docDetached = found.IsDetached;
    try { docCentral = ModelPathUtils.ConvertModelPathToUserVisiblePath(found.GetWorksharingCentralModelPath()); } catch (Exception) { docCentral = ""; }
}
return new { ok = true, exists = true, isWorkshared = info.IsWorkshared, isCentral, centralPath, docFound = found != null, docTitle = found == null ? "" : found.Title, docPath = found == null ? "" : (found.PathName ?? ""), docFamily = found != null && found.IsFamilyDocument, docWorkshared = found != null && found.IsWorkshared, docDetached, docActive = found != null && uiapp.ActiveUIDocument != null && found.Equals(uiapp.ActiveUIDocument.Document), docCentral, docs };
`;

const NEW_LOCAL_SCRIPT = `
var watch = System.Diagnostics.Stopwatch.StartNew();
string central = __CENTRAL__;
string local = __LOCAL__;
if (!System.IO.File.Exists(central)) return new { ok = false, step = "create_local", message = "Central not found. The backup was kept." };
var info = BasicFileInfo.Extract(central);
bool isCentralFlag = false;
try { isCentralFlag = info.IsCentral; } catch (Exception) { isCentralFlag = false; }
string infoCentral = info.CentralPath ?? "";
bool centralSelf = false;
try { centralSelf = string.Equals(System.IO.Path.GetFullPath(infoCentral), System.IO.Path.GetFullPath(central), StringComparison.OrdinalIgnoreCase); } catch (Exception) { centralSelf = string.Equals(infoCentral, central, StringComparison.OrdinalIgnoreCase); }
if (!info.IsWorkshared || !(isCentralFlag || centralSelf)) return new { ok = false, step = "create_local", message = "The file is not a central. The backup was kept. The central was not written." };
try
{
    ModelPath source = ModelPathUtils.ConvertUserVisiblePathToModelPath(central);
    ModelPath dest = ModelPathUtils.ConvertUserVisiblePathToModelPath(local);
    WorksharingUtils.CreateNewLocal(source, dest);
}
catch (Exception ex) { return new { ok = false, step = "create_local", message = "CreateNewLocal failed: " + ex.Message + " The backup was kept." }; }
var openOptions = new OpenOptions();
openOptions.DetachFromCentralOption = DetachFromCentralOption.DoNotDetach;
openOptions.SetOpenWorksetsConfiguration(new WorksetConfiguration(WorksetConfigurationOption.OpenAllWorksets));
Document opened;
try { opened = document.Application.OpenDocumentFile(ModelPathUtils.ConvertUserVisiblePathToModelPath(local), openOptions); }
catch (Exception ex) { return new { ok = false, step = "open", path = local, message = "Step 6 could not open the new local in the background: " + ex.Message + " The file is at " + local + "." }; }
int worksets = new FilteredWorksetCollector(opened).OfKind(WorksetKind.UserWorkset).ToWorksets().Count;
string openedCentral = "";
try { openedCentral = ModelPathUtils.ConvertModelPathToUserVisiblePath(opened.GetWorksharingCentralModelPath()); } catch (Exception) { openedCentral = ""; }
bool openedIsCentral = false;
try { openedIsCentral = !string.IsNullOrEmpty(opened.PathName) && string.Equals(System.IO.Path.GetFullPath(openedCentral), System.IO.Path.GetFullPath(opened.PathName), StringComparison.OrdinalIgnoreCase); } catch (Exception) { openedIsCentral = false; }
bool isLocal = opened.IsWorkshared && !opened.IsDetached && !openedIsCentral;
return new { ok = true, title = opened.Title, path = opened.PathName ?? local, isWorkshared = opened.IsWorkshared, isLocal, central = openedCentral, worksets, elapsed_ms = watch.ElapsedMilliseconds, opened_how = "background" };
`;

export interface MoveFs {
  existsSync(p: string): boolean;
  renameSync(from: string, to: string): void;
}

/**
 * Move the closed local, and its sibling _backup folder, onto free backup names.
 * fs.rename on the same volume. Nothing is copied and nothing is deleted.
 * After the moves the target path must be gone, or CreateNewLocal is not called.
 */
export function moveBackup(plan: Pick<NewLocalPlan, "local" | "backup" | "backup_folder_from" | "backup_folder_to">, io: MoveFs = fs): void {
  if (io.existsSync(plan.local)) {
    if (io.existsSync(plan.backup)) throw new Error(`Backup already exists: ${plan.backup}. Nothing was overwritten.`);
    io.renameSync(plan.local, plan.backup);
  }
  if (plan.backup_folder_from && io.existsSync(plan.backup_folder_from)) {
    if (io.existsSync(plan.backup_folder_to)) throw new Error(`Backup folder already exists: ${plan.backup_folder_to}. Nothing was overwritten.`);
    io.renameSync(plan.backup_folder_from, plan.backup_folder_to);
  }
  if (io.existsSync(plan.local)) {
    throw new Error(`The local is still at ${plan.local} after the move. CreateNewLocal was not called.`);
  }
}

export interface NewLocalRun {
  ok: boolean;
  step?: string;
  closed?: boolean;
  active?: boolean;
  message?: string;
  note?: string;
  title?: unknown;
  path?: unknown;
  isWorkshared?: unknown;
  isLocal?: unknown;
  central?: unknown;
  worksets?: unknown;
  backup?: string;
  elapsed_ms?: number;
  opened_how?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function codeResult(response: unknown): Record<string, unknown> | null {
  const row = asRecord(response);
  if (row?.success === false) {
    return { ok: false, step: "create_local", message: String(row.errorMessage || row.error || "The script failed. The backup was kept.") };
  }
  let result: unknown = row && "result" in row ? row.result : response;
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch { return null; }
  }
  return asRecord(result);
}

function failText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Switch, close, copy, CreateNewLocal, background open, then activate.
 * The switch and the close are back to back. A refused switch does not close.
 */
export async function runNewLocalSteps(
  plan: NewLocalPlan,
  sendCommand: (command: string, params: Record<string, unknown>) => Promise<unknown>,
  move: (plan: NewLocalPlan) => void = moveBackup,
): Promise<NewLocalRun> {
  const started = Date.now();
  const scriptAt = plan.calls.findIndex((call) => call.command === "fmc_new_local");
  const makeLocal = plan.calls[scriptAt];
  const activateNew = plan.calls[scriptAt + 1];
  if (!plan.resume) {
    const activateOther = plan.calls[0];
    const closeLocal = plan.calls[1];
    try {
      await sendCommand(activateOther.command, activateOther.params);
    } catch (error) {
      return { ok: false, step: "switch", closed: false, message: `Step 2 could not activate ${plan.switch_to} (${plan.switch_path}). ${failText(error)} Nothing was closed.` };
    }
    try {
      await sendCommand(closeLocal.command, closeLocal.params);
    } catch (error) {
      return { ok: false, step: "close", closed: false, message: `Step 3 could not close ${plan.document}. ${failText(error)} Nothing else was changed.` };
    }
  }
  try {
    move(plan);
  } catch (error) {
    return { ok: false, step: "backup", closed: true, backup: plan.backup, message: `${failText(error)} Nothing was deleted.` };
  }
  let made: Record<string, unknown> | null;
  try {
    made = codeResult(await sendCommand(makeLocal.command, makeLocal.params));
  } catch (error) {
    return { ok: false, step: "create_local", closed: true, backup: plan.backup, message: `${failText(error)} The backup was kept.` };
  }
  if (!made || made.ok === false) {
    return { ok: false, step: String(made?.step ?? "create_local"), closed: true, backup: plan.backup, message: String(made?.message ?? "CreateNewLocal failed. The backup was kept.") };
  }
  const summary = {
    ok: true, closed: true, title: made.title, path: made.path ?? plan.local, isWorkshared: made.isWorkshared, isLocal: made.isLocal,
    central: made.central, worksets: made.worksets, backup: plan.backup, opened_how: made.opened_how, elapsed_ms: Date.now() - started,
  };
  try {
    await sendCommand(activateNew.command, activateNew.params);
  } catch (error) {
    return { ...summary, active: false, note: `The new local is open in the background. Activating it was refused: ${failText(error)}` };
  }
  return { ...summary, active: true };
}
