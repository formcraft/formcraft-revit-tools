/**
 * Keynote tags, a keynote legend, and placing a schedule on a sheet.
 *
 * Revit 2025's public API cannot do what Annotate > Keynote does. IndependentTag.Create leaves Key Source unset,
 * and Parameter.Set throws because KEY_SOURCE_PARAM is read-only in the API while the UI can still change it
 * (IsReadOnly true, UserModifiable true). The UI writes through Element.setParameterValue. Parameter.SetInternal
 * is that path and skips the API read-only check. A tag is kept only when Key Source reads back as Element,
 * Material or User; otherwise it is deleted in the same transaction. The installed add-in is not involved:
 * modify_model sends one fixed script through send_code_to_revit (one transaction, the same live-model lock,
 * batch lease and approval as any other write). A server hot-swap is enough.
 */
import { screenScript } from "./scriptguard.js";

export const KEYNOTE_MODES = ["keynote_element", "keynote_material", "keynote_user"] as const;
export type KeynoteMode = (typeof KEYNOTE_MODES)[number];

const SOURCE: Record<KeynoteMode, string> = {
  keynote_element: "Element",
  keynote_material: "Material",
  keynote_user: "User",
};

export interface KeynoteOp {
  op: string;
  [key: string]: unknown;
}

export type SendCommand = (command: string, params: Record<string, unknown>) => Promise<unknown>;

/** The script body. The batch is parameters[0], a JSON object, so element ids never enter the source. */
export const KEYNOTE_SCRIPT = `
var raw = parameters != null && parameters.Length > 0 ? parameters[0] as string : null;
if (string.IsNullOrWhiteSpace(raw)) throw new InvalidOperationException("keynote batch is missing its payload");
var batch = JObject.Parse(raw);
bool dry = batch.Value<bool?>("dry_run") ?? false;
var made = new List<List<long>>();
var opsOut = new JArray();
int knownElement = int.MinValue, knownMaterial = int.MinValue, knownUser = int.MinValue;
string how = "";
BindingFlags hidden = BindingFlags.Instance | BindingFlags.NonPublic;
var setInt = typeof(Parameter).GetMethod("SetInternal", hidden, null, new System.Type[] { typeof(int), typeof(bool).MakeByRefType() }, null);
var setStr = typeof(Parameter).GetMethod("SetInternal", hidden, null, new System.Type[] { typeof(string), typeof(bool).MakeByRefType() }, null);
var unlock = typeof(APIObject).GetMethod("set_IsReadOnlyInternal", hidden);

bool WriteBoxed(System.Reflection.MethodInfo method, Parameter p, object value)
{
    if (method == null || p == null) return false;
    object[] args = new object[] { value, false };
    try
    {
        object got = method.Invoke(p, args);
        return got is bool ok && ok;
    }
    catch (System.Exception) { return false; }
}
string SourceText(Element tag)
{
    Parameter p = tag.get_Parameter(BuiltInParameter.KEY_SOURCE_PARAM);
    return (p == null ? "" : p.AsValueString() ?? "").Trim();
}
bool Same(string shown, string want)
{
    return string.Equals(shown, want, System.StringComparison.OrdinalIgnoreCase);
}
bool SetSource(Element tag, string want, ref int known)
{
    Parameter p = tag.get_Parameter(BuiltInParameter.KEY_SOURCE_PARAM);
    if (p == null) return false;
    if (known != int.MinValue)
    {
        WriteBoxed(setInt, p, known);
        document.Regenerate();
        if (Same(SourceText(tag), want)) { if (how == "") how = "SetInternal"; return true; }
    }
    if (WriteBoxed(setStr, p, want))
    {
        document.Regenerate();
        if (Same(SourceText(tag), want))
        {
            known = p.AsInteger();
            if (how == "") how = "SetInternal";
            return true;
        }
    }
    int[] order = want == "Material" ? new[] { 1, 2, 0, 3, -1 } : want == "User" ? new[] { 2, 3, 1, 0, -1 } : new[] { 0, 1, 2, 3, -1 };
    foreach (int n in order)
    {
        if (!WriteBoxed(setInt, p, n)) continue;
        document.Regenerate();
        if (!Same(SourceText(tag), want)) continue;
        known = n;
        if (how == "") how = "SetInternal";
        return true;
    }
    if (unlock != null)
    {
        try { unlock.Invoke(p, new object[] { false }); } catch (System.Exception) { }
        foreach (int n in order)
        {
            try { if (!p.Set(n)) continue; }
            catch (System.Exception) { continue; }
            document.Regenerate();
            if (!Same(SourceText(tag), want)) continue;
            known = n;
            if (how == "") how = "Set";
            return true;
        }
    }
    return false;
}
string TextKey(Element e)
{
    if (e == null) return "";
    Parameter p = e.get_Parameter(BuiltInParameter.KEYNOTE_PARAM);
    string s = p == null ? "" : (p.AsString() ?? "");
    return s.Trim();
}
string ElementKey(Element e)
{
    string s = TextKey(e);
    if (s != "") return s;
    Element type = e.GetTypeId() == ElementId.InvalidElementId ? null : document.GetElement(e.GetTypeId());
    return TextKey(type);
}
XYZ Where(Element e)
{
    if (e.Location is LocationPoint lp) return lp.Point;
    if (e.Location is LocationCurve lc) return lc.Curve.Evaluate(0.5, true);
    BoundingBoxXYZ bb = e.get_BoundingBox(null);
    if (bb == null) throw new InvalidOperationException(e.Id.Value + " has no location to tag");
    return (bb.Min + bb.Max) / 2;
}
void Faces(GeometryElement g, System.Action<Face> take)
{
    if (g == null) return;
    foreach (GeometryObject o in g)
    {
        if (o is Solid solid && solid.Faces.Size > 0) foreach (Face f in solid.Faces) take(f);
        else if (o is GeometryInstance gi) Faces(gi.GetInstanceGeometry(), take);
    }
}
Reference MaterialFace(Element e, View view, out string key)
{
    string[] found = new string[] { "" };
    Reference[] any = new Reference[] { null };
    var opt = new Options { ComputeReferences = true, View = view };
    Faces(e.get_Geometry(opt), f =>
    {
        if (found[0] != "" || f.Reference == null) return;
        if (any[0] == null) any[0] = f.Reference;
        if (f.MaterialElementId == ElementId.InvalidElementId) return;
        Material mat = document.GetElement(f.MaterialElementId) as Material;
        string k = TextKey(mat);
        if (k == "") return;
        any[0] = f.Reference;
        found[0] = k;
    });
    key = found[0];
    return any[0];
}
Element ById(JToken t)
{
    if (t == null || t.Type == JTokenType.Null) return null;
    if (t.Type == JTokenType.Integer || t.Type == JTokenType.Float)
        return document.GetElement(new ElementId(t.Value<long>()));
    string s = t.ToString().Trim();
    long n;
    if (long.TryParse(s, out n))
    {
        Element e = document.GetElement(new ElementId(n));
        if (e != null) return e;
    }
    return document.GetElement(s);
}
View ViewOf(JToken token)
{
    if (token == null || token.Type == JTokenType.Null) throw new InvalidOperationException("a view is required");
    string text = token.Type == JTokenType.String ? token.Value<string>() : token.ToString();
    text = (text ?? "").Trim();
    if (text.StartsWith("$"))
    {
        int n;
        if (!int.TryParse(text.Substring(1), out n) || n < 1 || n > made.Count || made[n - 1].Count == 0)
            throw new InvalidOperationException(text + " is not a view made by an earlier op in this batch");
        Element madeEl = document.GetElement(new ElementId(made[n - 1][0]));
        View madeView = madeEl as View;
        if (madeView == null) throw new InvalidOperationException(text + " is not a view");
        return madeView;
    }
    Element direct = ById(token);
    if (direct is View directView) return directView;
    foreach (View v in new FilteredElementCollector(document).OfClass(typeof(View)).Cast<View>())
    {
        if (v.IsTemplate) continue;
        if (string.Equals(v.Name, text, System.StringComparison.OrdinalIgnoreCase)) return v;
        ViewSheet sheet = v as ViewSheet;
        if (sheet != null && string.Equals(sheet.SheetNumber, text, System.StringComparison.OrdinalIgnoreCase)) return v;
    }
    throw new InvalidOperationException("no view " + text);
}
FamilySymbol TagSymbol(string name)
{
    var syms = new FilteredElementCollector(document).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
        .Where(f => f.Category != null && (f.Category.CategoryType == CategoryType.Annotation || f.Category.Id.Value == (long)BuiltInCategory.OST_KeynoteTags))
        .ToList();
    if (string.IsNullOrWhiteSpace(name))
    {
        Category cat = Category.GetCategory(document, BuiltInCategory.OST_KeynoteTags);
        if (cat == null) throw new InvalidOperationException("this model has no keynote tag category");
        ElementId def = document.GetDefaultFamilyTypeId(cat.Id);
        FamilySymbol fallback = document.GetElement(def) as FamilySymbol;
        if (fallback == null) throw new InvalidOperationException("no keynote tag is loaded (load M_Keynote Tag or FMC_TAG_Keynote)");
        return fallback;
    }
    string wanted = name.Trim();
    FamilySymbol exact = syms.FirstOrDefault(f =>
        string.Equals(f.Name, wanted, System.StringComparison.OrdinalIgnoreCase)
        || string.Equals(f.FamilyName + ": " + f.Name, wanted, System.StringComparison.OrdinalIgnoreCase)
        || string.Equals(f.FamilyName + " : " + f.Name, wanted, System.StringComparison.OrdinalIgnoreCase));
    if (exact != null) return exact;
    var family = syms.Where(f => string.Equals(f.FamilyName, wanted, System.StringComparison.OrdinalIgnoreCase)).ToList();
    if (family.Count == 1) return family[0];
    if (family.Count > 1)
        throw new InvalidOperationException("tag type " + wanted + " matches " + family.Count + " types (" + string.Join(", ", family.Select(f => f.FamilyName + ": " + f.Name).Take(8)) + "). Name one type, for example " + family[0].FamilyName + ": " + family[0].Name + ".");
    throw new InvalidOperationException("no tag type " + wanted + " (load the keynote tag family first)");
}
XYZ OffsetOf(JToken t)
{
    if (t == null || t.Type == JTokenType.Null) return XYZ.Zero;
    JArray a = t as JArray;
    if (a == null || a.Count < 2) return XYZ.Zero;
    double z = a.Count > 2 ? a[2].Value<double>() : 0;
    return new XYZ(FmcScript.Mm(a[0].Value<double>()), FmcScript.Mm(a[1].Value<double>()), FmcScript.Mm(z));
}
bool WriteKey(Element tag, string key)
{
    Parameter kv = tag.get_Parameter(BuiltInParameter.KEY_VALUE) ?? tag.get_Parameter(BuiltInParameter.KEYNOTE_NUMBER);
    if (kv == null) return false;
    if (!WriteBoxed(setStr, kv, key))
    {
        try { if (!kv.Set(key)) return false; }
        catch (System.Exception) { return false; }
    }
    document.Regenerate();
    string shown = kv.AsString() ?? "";
    return string.Equals(shown.Trim(), key, System.StringComparison.OrdinalIgnoreCase);
}
string ShownKey(IndependentTag tag)
{
    Parameter kv = tag.get_Parameter(BuiltInParameter.KEY_VALUE) ?? tag.get_Parameter(BuiltInParameter.KEYNOTE_NUMBER);
    string s = kv == null ? "" : (kv.AsString() ?? "").Trim();
    return s;
}

foreach (JObject op in (batch["ops"] as JArray ?? new JArray()).OfType<JObject>())
{
    string name = op.Value<string>("op") ?? "";
    var created = new List<long>();
    if (name == "tag")
    {
        string mode = op.Value<string>("mode") ?? "";
        string want = mode == "keynote_material" ? "Material" : mode == "keynote_user" ? "User" : "Element";
        ref int known = ref knownElement;
        if (want == "Material") known = ref knownMaterial;
        else if (want == "User") known = ref knownUser;
        View view = ViewOf(op["view"]);
        FamilySymbol sym = TagSymbol(op.Value<string>("tag_type"));
        if (!sym.IsActive) sym.Activate();
        bool leader = op.Value<bool?>("leader") ?? true;
        bool onePer = op.Value<bool?>("one_per_key") ?? true;
        TagOrientation orient = (op.Value<string>("orientation") ?? "horizontal") == "vertical" ? TagOrientation.Vertical : TagOrientation.Horizontal;
        XYZ nudge = OffsetOf(op["offset_mm"]);
        string userKey = (op.Value<string>("key") ?? "").Trim();
        var seen = new HashSet<string>(System.StringComparer.OrdinalIgnoreCase);
        if (onePer)
        {
            foreach (IndependentTag existing in new FilteredElementCollector(document, view.Id).OfClass(typeof(IndependentTag)).Cast<IndependentTag>())
            {
                if (!Same(SourceText(existing), want)) continue;
                string have = ShownKey(existing);
                if (have != "") seen.Add(have);
            }
        }
        var skipped = new JArray();
        JArray ids = op["ids"] as JArray ?? new JArray();
        if (ids.Count > 2000) throw new InvalidOperationException("tag takes at most 2000 elements; split the batch");
        foreach (JToken t in ids)
        {
            Element e = ById(t);
            long id = e != null ? e.Id.Value : (t.Type == JTokenType.Integer ? t.Value<long>() : 0);
            if (e == null) { skipped.Add(new JObject { ["id"] = t.ToString(), ["reason"] = "isn't in this model" }); continue; }
            string key = "";
            Reference host = new Reference(e);
            if (want == "Material")
            {
                string matKey;
                Reference face = MaterialFace(e, view, out matKey);
                if (face == null) { skipped.Add(new JObject { ["id"] = id, ["reason"] = "no face to take a material keynote from" }); continue; }
                if (matKey == "") { skipped.Add(new JObject { ["id"] = id, ["reason"] = "no material keynote" }); continue; }
                host = face;
                key = matKey;
            }
            else if (want == "User")
            {
                key = userKey;
                if (key == "") { skipped.Add(new JObject { ["id"] = id, ["reason"] = "user keynote needs key" }); continue; }
            }
            else
            {
                key = ElementKey(e);
                if (key == "") { skipped.Add(new JObject { ["id"] = id, ["reason"] = "no keynote on the element" }); continue; }
            }
            if (onePer && seen.Contains(key))
            {
                skipped.Add(new JObject { ["id"] = id, ["key"] = key, ["reason"] = "key already tagged in this view" });
                continue;
            }
            XYZ at = Where(e);
            if (!leader && nudge.GetLength() > 1e-9) at = at + nudge;
            IndependentTag tag;
            try
            {
                tag = IndependentTag.Create(document, sym.Id, view.Id, host, leader, orient, at);
            }
            catch (System.Exception ex)
            {
                skipped.Add(new JObject { ["id"] = id, ["key"] = key, ["reason"] = ex.Message });
                continue;
            }
            if (leader && nudge.GetLength() > 1e-9) tag.TagHeadPosition = tag.TagHeadPosition + nudge;
            if (!SetSource(tag, want, ref known))
            {
                string after = SourceText(tag);
                document.Delete(tag.Id);
                string shown = after == "" ? "unset" : after;
                skipped.Add(new JObject { ["id"] = id, ["key"] = key, ["reason"] = "Key Source stayed " + shown + ". Revit did not keep " + want });
                continue;
            }
            if (want == "User" && !WriteKey(tag, key))
            {
                document.Delete(tag.Id);
                skipped.Add(new JObject { ["id"] = id, ["key"] = key, ["reason"] = "Key Value could not be set" });
                continue;
            }
            if (onePer) seen.Add(key);
            created.Add(tag.Id.Value);
        }
        var row = new JObject
        {
            ["op"] = opsOut.Count + 1, ["kind"] = "tag", ["mode"] = mode, ["view"] = view.Name,
            ["tag_type"] = sym.FamilyName + ": " + sym.Name, ["key_source"] = want,
            ["tagged"] = created.Count, ["created_ids"] = new JArray(created), ["skipped"] = skipped,
            ["counts"] = new JObject { ["created"] = created.Count, ["skipped"] = skipped.Count },
        };
        if (how != "") row["how"] = how;
        opsOut.Add(row);
        made.Add(created);
        continue;
    }
    if (name == "keynote_legend")
    {
        ViewSchedule legend = ViewSchedule.CreateKeynoteLegend(document);
        string legendName = op.Value<string>("name");
        if (!string.IsNullOrWhiteSpace(legendName)) legend.Name = legendName.Trim();
        bool filter = op.Value<bool?>("filtered_by_sheet") ?? false;
        if (filter)
        {
            if (!legend.Definition.IsValidCategoryForFilterBySheet())
                throw new InvalidOperationException("this keynote legend cannot be filtered by sheet");
            legend.Definition.IsFilteredBySheet = true;
        }
        created.Add(legend.Id.Value);
        opsOut.Add(new JObject
        {
            ["op"] = opsOut.Count + 1, ["kind"] = "keynote_legend", ["name"] = legend.Name,
            ["schedule"] = legend.Id.Value, ["filtered_by_sheet"] = legend.Definition.IsFilteredBySheet,
            ["created_ids"] = new JArray(legend.Id.Value),
            ["counts"] = new JObject { ["created"] = 1, ["skipped"] = 0 },
        });
        made.Add(created);
        continue;
    }
    if (name == "place_schedule")
    {
        View sheetView = ViewOf(op["sheet"]);
        ViewSheet sheet = sheetView as ViewSheet;
        if (sheet == null) throw new InvalidOperationException(sheetView.Name + " isn't a sheet");
        View scheduleView = ViewOf(op["schedule"]);
        ViewSchedule schedule = scheduleView as ViewSchedule;
        if (schedule == null) throw new InvalidOperationException(scheduleView.Name + " isn't a schedule or legend");
        JArray pt = op["point_mm"] as JArray;
        if (pt == null || pt.Count < 2) throw new InvalidOperationException("place_schedule needs point_mm [x, y] on the sheet");
        XYZ at = FmcScript.PointMm(pt[0].Value<double>(), pt[1].Value<double>(), 0);
        ScheduleSheetInstance placed = ScheduleSheetInstance.Create(document, sheet.Id, schedule.Id, at);
        created.Add(placed.Id.Value);
        opsOut.Add(new JObject
        {
            ["op"] = opsOut.Count + 1, ["kind"] = "place_schedule", ["sheet"] = sheet.SheetNumber,
            ["schedule"] = schedule.Name, ["placed"] = placed.Id.Value, ["created_ids"] = new JArray(placed.Id.Value),
            ["counts"] = new JObject { ["created"] = 1, ["skipped"] = 0 },
        });
        made.Add(created);
        continue;
    }
    throw new InvalidOperationException(name + " is not a keynote batch op");
}
return new JObject
{
    ["applied"] = !dry,
    ["dry_run"] = dry,
    ["ops"] = opsOut,
    ["note"] = dry
        ? "Dry run: the batch ran and was rolled back. Nothing was saved, synced or relinquished."
        : "Key Source is written with Parameter.SetInternal because the public Set is read-only. A tag is kept only when Key Source reads back as Element, Material or User.",
};
`.trim();

const MARK = "FMC-KEYNOTE-SUMMARY:";

export function isKeynoteMode(mode: unknown): mode is KeynoteMode {
  return typeof mode === "string" && (KEYNOTE_MODES as readonly string[]).includes(mode);
}

export function isKeynoteOp(op: KeynoteOp | null | undefined): boolean {
  if (!op || typeof op !== "object") return false;
  if (op.op === "keynote_legend" || op.op === "place_schedule") return true;
  return op.op === "tag" && isKeynoteMode(op.mode);
}

function mentionsKeynote(op: KeynoteOp): boolean {
  if (isKeynoteOp(op)) return true;
  if (op.op === "for_each" && Array.isArray(op.ops)) return op.ops.some((inner) => mentionsKeynote(inner as KeynoteOp));
  return false;
}

/** keynote: this batch is only the bridge ops. model: the add-in runs it. mixed/for_each: refuse before any write. */
export function classifyKeynoteBatch(ops: KeynoteOp[]): "keynote" | "model" | "mixed" | "for_each" {
  if (ops.some((op) => op?.op === "for_each" && mentionsKeynote(op))) return "for_each";
  const flagged = ops.filter(isKeynoteOp);
  if (flagged.length === 0) return "model";
  if (flagged.length === ops.length) return "keynote";
  return "mixed";
}

function asId(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function pointProblem(value: unknown, label: string, what: string): string | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return `${label} needs ${what}`;
  if (!value.every((n) => typeof n === "number" && Number.isFinite(n))) return `${label} point_mm must be finite numbers`;
  return null;
}

/** Problems found before Revit. select is already resolved into ids. */
export function validateKeynoteOps(ops: KeynoteOp[]): string | null {
  if (ops.length === 0) return "modify_model needs at least one op";
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const where = `op ${i + 1}`;
    if (op.op === "tag") {
      if (!isKeynoteMode(op.mode)) return `${where}: keynote tagging needs mode keynote_element, keynote_material or keynote_user`;
      if (op.view == null || String(op.view).trim() === "") return `${where}: tag needs view`;
      const ids = Array.isArray(op.ids) ? op.ids : [];
      if (ids.length === 0) return `${where}: tag needs ids or select`;
      if (ids.length > 2000) return `${where}: tag takes at most 2000 elements; split the batch`;
      if (ids.some((id) => asId(id) == null)) return `${where}: ids must be element ids`;
      if (op.mode === "keynote_user" && (typeof op.key !== "string" || !op.key.trim())) return `${where}: a user keynote needs key (the keynote code, for example A.WAL_01)`;
      if (op.orientation != null && op.orientation !== "horizontal" && op.orientation !== "vertical") return `${where}: orientation is horizontal or vertical`;
      if (op.offset_mm != null) {
        const offset = pointProblem(op.offset_mm, where, "offset_mm [x, y]");
        if (offset) return offset;
      }
    } else if (op.op === "keynote_legend") {
      if (op.name != null && typeof op.name !== "string") return `${where}: keynote_legend name must be text`;
      if (op.filtered_by_sheet != null && typeof op.filtered_by_sheet !== "boolean") return `${where}: filtered_by_sheet must be true or false`;
    } else if (op.op === "place_schedule") {
      if (op.sheet == null || String(op.sheet).trim() === "") return `${where}: place_schedule needs sheet`;
      if (op.schedule == null || String(op.schedule).trim() === "") return `${where}: place_schedule needs schedule`;
      const point = pointProblem(op.point_mm, where, "point_mm [x, y] on the sheet");
      if (point) return point;
    } else {
      return `${where}: ${op.op} cannot share a batch with keynote tagging. Put keynote_element, keynote_material, keynote_user, keynote_legend and place_schedule in their own modify_model call.`;
    }
  }
  return null;
}

export function keynoteSummaries(ops: KeynoteOp[], dryRun: boolean): string[] {
  const lines = ops.map((op, i) => {
    const n = `${i + 1}.`;
    if (op.op === "tag") {
      const src = SOURCE[op.mode as KeynoteMode] ?? "Element";
      const count = Array.isArray(op.ids) ? op.ids.length : 0;
      const type = typeof op.tag_type === "string" && op.tag_type.trim() ? ` with ${op.tag_type.trim()}` : "";
      const per = op.one_per_key === false ? "" : ", one tag per key";
      const leader = op.leader === false ? "" : ", leader on";
      return `${n} Keynote tag (${src}) in ${op.view} on ${count} elements${type}${per}${leader}.`;
    }
    if (op.op === "keynote_legend") {
      const name = typeof op.name === "string" && op.name.trim() ? ` "${op.name.trim()}"` : "";
      return `${n} Keynote legend${name}${op.filtered_by_sheet ? ", filtered by sheet" : ""}.`;
    }
    const pt = Array.isArray(op.point_mm) ? op.point_mm.slice(0, 2).map((n) => Math.round(Number(n))).join(", ") : "?";
    return `${n} Place ${op.schedule} on sheet ${op.sheet} at (${pt}) mm.`;
  });
  if (dryRun) lines.unshift("Dry run: Revit rolls this batch back. Nothing is kept.");
  return lines;
}

function payloadOp(op: KeynoteOp): Record<string, unknown> {
  if (op.op === "tag") {
    const row: Record<string, unknown> = {
      op: "tag",
      mode: op.mode,
      view: op.view,
      ids: op.ids,
      one_per_key: op.one_per_key !== false,
      leader: op.leader !== false,
    };
    if (typeof op.tag_type === "string" && op.tag_type.trim()) row.tag_type = op.tag_type.trim();
    if (typeof op.orientation === "string") row.orientation = op.orientation;
    if (Array.isArray(op.offset_mm)) row.offset_mm = op.offset_mm;
    if (op.mode === "keynote_user") row.key = String(op.key).trim();
    return row;
  }
  if (op.op === "keynote_legend") {
    const row: Record<string, unknown> = { op: "keynote_legend", filtered_by_sheet: op.filtered_by_sheet === true };
    if (typeof op.name === "string" && op.name.trim()) row.name = op.name.trim();
    return row;
  }
  return { op: "place_schedule", sheet: op.sheet, schedule: op.schedule, point_mm: op.point_mm };
}

export function keynoteCall(ops: KeynoteOp[], dryRun: boolean, document?: string): { params: Record<string, unknown>; code: string } {
  const summaries = keynoteSummaries(ops, dryRun);
  const code = summaries.map((line) => `// ${MARK} ${line}`).join("\n") + "\n" + KEYNOTE_SCRIPT;
  const problem = screenScript(code);
  if (problem) throw new Error(problem.message);
  const ids = ops.flatMap((op) => (Array.isArray(op.ids) ? op.ids : [])).filter((id) => typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id)));
  const params: Record<string, unknown> = {
    code,
    parameters: [JSON.stringify({ dry_run: dryRun, ops: ops.map(payloadOp) })],
    usings: ["System.Reflection", "Newtonsoft.Json.Linq"],
    transactionMode: dryRun ? "read_only" : "auto",
    dry_run: dryRun,
    purpose: "keynote tags, legend and place schedule",
    ...(ids.length ? { elementIds: ids.slice(0, 200) } : {}),
    ...(document ? { document } : {}),
  };
  return { params, code };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseResult(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return parseResult(JSON.parse(value)); } catch { return null; }
  }
  return asRecord(value);
}

/** The modify_model shape: counts, created ids, skipped with reasons. No picture. */
export function shapeKeynoteResult(response: unknown, dryRun: boolean): { body: Record<string, unknown>; isError: boolean } {
  const row = asRecord(response) ?? {};
  const stamped = asRecord(row.document);
  const parsed = parseResult(row.result);
  if (row.success === false) {
    return {
      isError: true,
      body: {
        applied: false,
        dry_run: dryRun,
        rolled_back: true,
        reason: row.errorMessage || row.error || "The keynote batch was rolled back. Nothing was changed.",
        errorCode: row.errorCode,
        ...(stamped ? { document: stamped } : {}),
      },
    };
  }
  const ops = Array.isArray(parsed?.ops) ? parsed.ops : [];
  const undo = typeof row.undoId === "string" && row.undoId ? row.undoId : undefined;
  return {
    isError: false,
    body: {
      applied: dryRun ? false : parsed?.applied !== false,
      dry_run: dryRun,
      ...(undo ? { batch_id: undo, undo_id: undo } : {}),
      ops,
      note: typeof parsed?.note === "string" ? parsed.note : undefined,
      ...(stamped ? { document: stamped } : {}),
      ...(Array.isArray(row.warnings) && row.warnings.length ? { warnings: row.warnings } : {}),
    },
  };
}

const REFUSAL = "Put keynote_element, keynote_material, keynote_user, keynote_legend and place_schedule in their own modify_model call. They run through the code bridge so Key Source can be set without an add-in update. Other ops stay on the add-in.";

async function resolveSelect(op: KeynoteOp, send: SendCommand): Promise<KeynoteOp> {
  if (!op.select || typeof op.select !== "object" || Array.isArray(op.select)) return op;
  const query = { ...(op.select as Record<string, unknown>) };
  if (query.limit == null) query.limit = 5000;
  const found = asRecord(await send("fmc_select_by", query));
  const selected = Array.isArray(found?.ids) ? found.ids : [];
  const ids = [...(Array.isArray(op.ids) ? op.ids : []), ...selected];
  const seen = new Set<string>();
  const unique: Array<string | number> = [];
  for (const id of ids) {
    const item = asId(id);
    if (item == null || seen.has(String(item))) continue;
    seen.add(String(item));
    unique.push(item);
  }
  const { select: _select, ...rest } = op;
  return { ...rest, ids: unique };
}

/**
 * Runs a keynote-only batch. Returns null when the batch belongs to the add-in.
 * Refuses a mix, and a for_each that contains a keynote op, before anything is written.
 */
export async function executeKeynoteBatch(
  ops: KeynoteOp[],
  dryRun: boolean,
  document: string | undefined,
  send: SendCommand,
): Promise<{ body: Record<string, unknown>; isError: boolean } | null> {
  const kind = classifyKeynoteBatch(ops);
  if (kind === "model") return null;
  if (kind === "for_each") {
    return { isError: true, body: { applied: false, reason: "A for_each that tags keynotes is not run on this path, because select would not see each pass. Pass ids, or one keynote batch per pass. Nothing was changed." } };
  }
  if (kind === "mixed") return { isError: true, body: { applied: false, reason: REFUSAL } };
  const resolved: KeynoteOp[] = [];
  for (const op of ops) resolved.push(op.op === "tag" ? await resolveSelect(op, send) : op);
  const problem = validateKeynoteOps(resolved);
  if (problem) return { isError: true, body: { applied: false, reason: problem } };
  const call = keynoteCall(resolved, dryRun, document);
  const response = await send("send_code_to_revit", call.params);
  return shapeKeynoteResult(response, dryRun);
}

/** Approval text for the bridge script: the summary lines, not the C#. */
export function keynoteApprovalLines(code: string): string[] | null {
  const lines = code.split(/\r?\n/).map((line) => {
    const at = line.indexOf(MARK);
    return at >= 0 ? line.slice(at + MARK.length).trim() : "";
  }).filter(Boolean);
  return lines.length ? lines : null;
}
