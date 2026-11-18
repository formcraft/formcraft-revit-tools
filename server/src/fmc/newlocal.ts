/**
 * fmc_new_local: a fresh workshared local from a central, opened in place of an open local.
 * The caller never supplies code. The server builds one fixed script and sends it through send_code_to_revit.
 * Only paths and titles that passed the literal check are placed in the script, as verbatim C# strings.
 */
import path from "node:path";
import { GuardConfig } from "./policy.js";
import { underAny, protectedRoots, samePath } from "./opencopy.js";
import { documentsMatch } from "./batchline.js";
import { screenScript } from "./scriptguard.js";

const win = path.win32;

/**
 * What the live add-in (ed5e130) allows this script to do.
 * send_code_to_revit compiles the body of Execute(Document document, object[] parameters) and runs it from
 * ExternalEvent.Execute(UIApplication). The script is not given a UIApplication parameter; it builds one with
 * new UIApplication(document.Application), which is valid in that API context.
 * Before the body runs, transactionMode "none" still starts a TransactionGroup on that document (ExecuteCodeEventHandler).
 * OpenAndActivateDocument is refused while a transaction group is open, and Close is refused on the active document
 * and on the document that group belongs to. The script is therefore bound to another open document. Step 2 tries
 * the UI switch and, if Revit refuses, stops before Close. Step 6 tries the UI open and falls back to
 * Application.OpenDocumentFile, which does not need to change the active document.
 */
export const NEW_LOCAL_CAVEAT =
  "Step 2 (activate another document) and the UI open in step 6 call UIApplication.OpenAndActivateDocument. " +
  "The live add-in runs every send_code_to_revit script inside a transaction group on the script's document, and Revit " +
  "refuses OpenAndActivateDocument while that group is open. The script is bound to the other open document, not to the " +
  "local being replaced. If the switch is refused, nothing is closed. If the UI open is refused, the new local is opened " +
  "in the background with Application.OpenDocumentFile and OpenAllWorksets.";

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
  /** True only when this plan would close a document. A dry run is never that. */
  closes: boolean;
  document: string;
  central: string;
  local: string;
  active: boolean;
  switch_to: string;
  /** Title or path passed as send_code's document, so the transaction group is not on the local. */
  script_document: string;
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

/** Another open document to activate, and to bind the script to. Project documents first. */
export function pickSwitch(docs: OpenDoc[], target: OpenDoc, requested?: string): OpenDoc | undefined {
  const others = otherDocs(docs, target);
  const want = (requested ?? "").trim();
  if (want) {
    const hit = findDocs(others, want);
    return hit.length === 1 ? hit[0] : undefined;
  }
  const project = others.find((d) => !d.isFamily);
  return project ?? others[0];
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
  if (document && hits.length === 0) reasons.push(`No open document is called "${document}".`);
  if (hits.length > 1) reasons.push(`"${document}" matches ${hits.length} open documents. Pass the full path.`);
  const doc = hits.length === 1 ? hits[0] : undefined;
  if (doc && !isLocalOf(doc, central)) reasons.push(`${doc.title} is not a local of ${central}.`);
  if (doc?.path && local && !samePath(doc.path, local)) reasons.push(`${doc.title} is open at ${doc.path}, not at ${local}.`);
  if (doc?.path && underAny(doc.path, prot)) reasons.push(`Protected original: ${doc.path}. Write, save, sync, reload and relinquish are refused.`);
  if (doc?.path) {
    const blocked = blockedReason(doc.path, ctx.cfg);
    if (blocked && !reasons.includes(blocked)) reasons.push(blocked);
  }

  const host = doc ? pickSwitch(ctx.docs, doc, input.switch_to) : undefined;
  if (doc && input.switch_to?.trim() && !host) reasons.push(`switch_to "${input.switch_to.trim()}" is not another open document.`);
  if (doc && !host) {
    reasons.push(doc.isActive
      ? `${doc.title} is the active document and no other open document can take the screen. Step 2 cannot run, so nothing is closed.`
      : `No other document is open. The script would be bound to ${doc.title}, and this add-in cannot close the document its transaction group belongs to.`);
  }

  if (doc && ctx.holder && (!ctx.caller || ctx.holder.client !== ctx.caller.client || ctx.holder.lease !== ctx.caller.lease)) {
    reasons.push(`Another lease holds ${doc.title} (${ctx.holder.client}, ${ctx.holder.lease}).`);
  }
  if (doc && ctx.queueRunning && ctx.caller && ctx.queueRunning.client !== ctx.caller.client && queueHits(ctx.queueRunning, doc, document)) {
    reasons.push(`Another caller is running a batch on ${doc.title} (${ctx.queueRunning.client}).`);
  }

  const names = local && !localPathProblem ? backupNames(local, suffix, ctx.exists) : { file: "", folderFrom: "", folderTo: "" };
  if (local && !localPathProblem && !names.file) reasons.push("No free backup name (tried -2 through -1000). Nothing was copied.");
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
    document,
    central,
    local,
    active: !!doc?.isActive,
    switch_to: host?.title || (input.switch_to ?? "").trim(),
    script_document: host?.title ?? "",
    backup: names.file,
    backup_folder_from: names.folderFrom,
    backup_folder_to: names.folderTo,
    steps: [],
    caveat: NEW_LOCAL_CAVEAT,
  };
  if (!base.ok || !doc || !host) return base;

  const steps = [
    `Validate ${central} is a central and ${doc.title} is a local of it.`,
    doc.isActive
      ? `Step 2: ${doc.title} is active. Activate ${host.title} with UIApplication.OpenAndActivateDocument. If Revit refuses, stop and close nothing.`
      : `Step 2: ${doc.title} is not active. Leave the active document as it is.`,
    `Step 3: Close ${doc.title} with Close(false), discarding unsaved changes.`,
    `Step 4: Copy the old local to ${names.file}` + (names.folderFrom ? ` and ${names.folderFrom} to ${names.folderTo}` : "") + ". Nothing is deleted.",
    `Step 5: WorksharingUtils.CreateNewLocal from ${central} onto ${local}.`,
    "Step 6: Open the new local with OpenAllWorksets. Prefer OpenAndActivateDocument; if the transaction group refuses, open it in the background.",
  ];
  let script: string | undefined;
  try {
    script = newLocalScript({
      central, local, targetTitle: doc.title, targetPath: doc.path,
      switchTitle: host.title, switchPath: host.path,
      backupFile: names.file, backupFolderFrom: names.folderFrom, backupFolderTo: names.folderTo,
    });
  } catch (error) {
    return { ...base, ok: false, reasons: [error instanceof Error ? error.message : String(error)] };
  }
  return { ...base, steps, script, closes: !dry };
}

export interface ScriptFields {
  central: string;
  local: string;
  targetTitle: string;
  targetPath: string;
  switchTitle: string;
  switchPath: string;
  backupFile: string;
  backupFolderFrom: string;
  backupFolderTo: string;
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
    .replaceAll("__LOCAL__", verbatim(fields.local, "local"))
    .replaceAll("__TARGET_TITLE__", verbatim(fields.targetTitle, "document"))
    .replaceAll("__TARGET_PATH__", verbatim(fields.targetPath, "local"))
    .replaceAll("__SWITCH_TITLE__", verbatim(fields.switchTitle, "switch_to"))
    .replaceAll("__SWITCH_PATH__", verbatim(fields.switchPath, "switch_to"))
    .replaceAll("__BACKUP_FILE__", verbatim(fields.backupFile, "backup"))
    .replaceAll("__BACKUP_FROM__", verbatim(fields.backupFolderFrom, "backup folder"))
    .replaceAll("__BACKUP_TO__", verbatim(fields.backupFolderTo, "backup folder"));
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
string targetTitle = __TARGET_TITLE__;
string targetPath = __TARGET_PATH__;
string switchTitle = __SWITCH_TITLE__;
string switchPath = __SWITCH_PATH__;
string backupFile = __BACKUP_FILE__;
string backupFrom = __BACKUP_FROM__;
string backupTo = __BACKUP_TO__;
UIApplication uiapp = new UIApplication(document.Application);
var app = uiapp.Application;
Document target = null;
foreach (Document d in app.Documents)
{
    if (d.IsLinked) continue;
    bool title = string.Equals(d.Title, targetTitle, StringComparison.OrdinalIgnoreCase);
    bool byPath = false;
    try { byPath = !string.IsNullOrEmpty(d.PathName) && string.Equals(System.IO.Path.GetFullPath(d.PathName), System.IO.Path.GetFullPath(targetPath), StringComparison.OrdinalIgnoreCase); } catch (Exception) { byPath = false; }
    if (title || byPath) target = d;
}
if (target == null) return new { ok = false, step = "validate", closed = false, message = "No open document matches the local. Nothing was closed." };
if (document.Equals(target)) return new { ok = false, step = "close", closed = false, message = "Step 3 cannot close the document the script is bound to: the add-in holds a transaction group on it. Nothing was closed." };
if (!System.IO.File.Exists(central)) return new { ok = false, step = "validate", closed = false, message = "Central not found. Nothing was closed." };
var info = BasicFileInfo.Extract(central);
bool isCentralFlag = false;
try { isCentralFlag = info.IsCentral; } catch (Exception) { isCentralFlag = false; }
string infoCentral = info.CentralPath ?? "";
bool centralSelf = false;
try { centralSelf = string.Equals(System.IO.Path.GetFullPath(infoCentral), System.IO.Path.GetFullPath(central), StringComparison.OrdinalIgnoreCase); } catch (Exception) { centralSelf = string.Equals(infoCentral, central, StringComparison.OrdinalIgnoreCase); }
if (!info.IsWorkshared || !(isCentralFlag || centralSelf)) return new { ok = false, step = "validate", closed = false, message = "The file is not a central. Nothing was closed." };
if (!target.IsWorkshared || target.IsDetached) return new { ok = false, step = "validate", closed = false, message = "The open document is not a workshared local. Nothing was closed." };
string docCentral = "";
try { docCentral = ModelPathUtils.ConvertModelPathToUserVisiblePath(target.GetWorksharingCentralModelPath()); } catch (Exception ex) { return new { ok = false, step = "validate", closed = false, message = "Could not read the local's central: " + ex.Message + " Nothing was closed." }; }
bool sameCentral = false;
bool docIsCentral = false;
try {
    sameCentral = string.Equals(System.IO.Path.GetFullPath(docCentral), System.IO.Path.GetFullPath(central), StringComparison.OrdinalIgnoreCase);
    docIsCentral = string.Equals(System.IO.Path.GetFullPath(docCentral), System.IO.Path.GetFullPath(target.PathName), StringComparison.OrdinalIgnoreCase);
} catch (Exception) {
    sameCentral = string.Equals(docCentral, central, StringComparison.OrdinalIgnoreCase);
    docIsCentral = string.Equals(docCentral, target.PathName, StringComparison.OrdinalIgnoreCase);
}
if (!sameCentral || docIsCentral) return new { ok = false, step = "validate", closed = false, message = "The open document is not a local of that central. Nothing was closed." };
Document activeDoc = uiapp.ActiveUIDocument == null ? null : uiapp.ActiveUIDocument.Document;
if (activeDoc != null && activeDoc.Equals(target))
{
    try { uiapp.OpenAndActivateDocument(switchPath); }
    catch (Exception ex)
    {
        return new { ok = false, step = "switch", closed = false, message = "Step 2 cannot activate " + switchTitle + ". OpenAndActivateDocument was refused (" + ex.Message + "). The add-in holds a transaction group for the whole script. Activate " + switchTitle + " in Revit, then run again. Nothing was closed." };
    }
}
activeDoc = uiapp.ActiveUIDocument == null ? null : uiapp.ActiveUIDocument.Document;
if (activeDoc != null && activeDoc.Equals(target)) return new { ok = false, step = "close", closed = false, message = "Step 3 cannot close the active document. Nothing was closed." };
bool closed = false;
try { closed = target.Close(false); }
catch (Exception ex) { return new { ok = false, step = "close", closed = false, message = "Step 3 Close(false) failed: " + ex.Message + " Nothing else was changed." }; }
if (!closed) return new { ok = false, step = "close", closed = false, message = "Revit did not close the document. Nothing else was changed." };
try
{
    System.IO.File.Copy(local, backupFile, false);
    if (backupFrom.Length > 0 && System.IO.Directory.Exists(backupFrom))
    {
        var stack = new List<string[]>();
        stack.Add(new[] { backupFrom, backupTo });
        for (int i = 0; i < stack.Count && i < 10000; i++)
        {
            string src = stack[i][0];
            string dst = stack[i][1];
            System.IO.Directory.CreateDirectory(dst);
            foreach (string file in System.IO.Directory.GetFiles(src))
                System.IO.File.Copy(file, System.IO.Path.Combine(dst, System.IO.Path.GetFileName(file)), false);
            foreach (string sub in System.IO.Directory.GetDirectories(src))
                stack.Add(new[] { sub, System.IO.Path.Combine(dst, System.IO.Path.GetFileName(sub)) });
        }
        if (stack.Count >= 10000) throw new InvalidOperationException("The backup folder is deeper than 10000 directories.");
    }
}
catch (Exception ex) { return new { ok = false, step = "backup", closed = true, message = "The document was closed and the backup copy failed: " + ex.Message + " The old file was not deleted." }; }
try
{
    ModelPath source = ModelPathUtils.ConvertUserVisiblePathToModelPath(central);
    ModelPath dest = ModelPathUtils.ConvertUserVisiblePathToModelPath(local);
    WorksharingUtils.CreateNewLocal(source, dest);
}
catch (Exception ex) { return new { ok = false, step = "create_local", closed = true, backup = backupFile, message = "CreateNewLocal failed: " + ex.Message + " The backup was kept." }; }
string how = "";
Document opened = null;
var openOptions = new OpenOptions();
openOptions.DetachFromCentralOption = DetachFromCentralOption.DoNotDetach;
openOptions.SetOpenWorksetsConfiguration(new WorksetConfiguration(WorksetConfigurationOption.OpenAllWorksets));
ModelPath openedPath = ModelPathUtils.ConvertUserVisiblePathToModelPath(local);
try
{
    UIDocument ui = uiapp.OpenAndActivateDocument(openedPath, openOptions, false);
    opened = ui.Document;
    how = "ui";
}
catch (Exception)
{
    try { opened = app.OpenDocumentFile(openedPath, openOptions); how = "background"; }
    catch (Exception openEx)
    {
        foreach (Document d in app.Documents)
        {
            if (d.IsLinked || string.IsNullOrEmpty(d.PathName)) continue;
            try { if (string.Equals(System.IO.Path.GetFullPath(d.PathName), System.IO.Path.GetFullPath(local), StringComparison.OrdinalIgnoreCase)) opened = d; } catch (Exception) { }
        }
        if (opened == null) return new { ok = false, step = "open", closed = true, backup = backupFile, path = local, message = "Step 6 could not open the new local. OpenAndActivateDocument and OpenDocumentFile were both refused (" + openEx.Message + "). The file is at " + local + "." };
        how = "already_open";
    }
}
if (opened == null) return new { ok = false, step = "open", closed = true, backup = backupFile, path = local, message = "Step 6 did not open the new local. The file is at " + local + "." };
int worksets = new FilteredWorksetCollector(opened).OfKind(WorksetKind.UserWorkset).ToWorksets().Count;
string openedCentral = "";
try { openedCentral = ModelPathUtils.ConvertModelPathToUserVisiblePath(opened.GetWorksharingCentralModelPath()); } catch (Exception) { openedCentral = ""; }
bool openedIsCentral = false;
try { openedIsCentral = !string.IsNullOrEmpty(opened.PathName) && string.Equals(System.IO.Path.GetFullPath(openedCentral), System.IO.Path.GetFullPath(opened.PathName), StringComparison.OrdinalIgnoreCase); } catch (Exception) { openedIsCentral = false; }
bool isLocal = opened.IsWorkshared && !opened.IsDetached && !openedIsCentral;
return new { ok = true, title = opened.Title, path = opened.PathName ?? local, isWorkshared = opened.IsWorkshared, isLocal, central = openedCentral, worksets, backup = backupFile, elapsed_ms = watch.ElapsedMilliseconds, opened_how = how };
`;
