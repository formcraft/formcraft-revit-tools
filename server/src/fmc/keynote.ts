/**
 * Keynote tags, a keynote legend, and placing a schedule on a sheet.
 *
 * Revit 2025's API does not create a linked keynote tag. IndependentTag.Create leaves TagText empty, Keynote Text
 * empty and Key Source with no value. SetInternal("Element") reads back the word and changes nothing. Parameter.Set
 * throws because the parameter is read-only. A probe tag is made in a sub-transaction and rolled back. If that tag
 * is blank, nothing is placed and the answer is FMC-NO-API-KEYNOTE-LINK: Annotate > Keynote > Element, or Tag All
 * Not Tagged with Keynote Tags, per view. keynote_retag posts that command (FMC-NEEDS-HUMAN). keynote_clone copies
 * one linked tag and repoints it. keynote_audit lists blank keynote tags and does not delete them.
 * The installed add-in is not involved for these ops: modify_model sends one fixed script through send_code_to_revit.
 * A server hot-swap is enough, except the generic tag op in the add-in, which also refuses a keynote tag type.
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
HashSet<string> tableKeys = null;
string tableError = null;
bool tableLoaded = false;
const string NO_LINK = "FMC-NO-API-KEYNOTE-LINK";
const string NEEDS_HUMAN = "FMC-NEEDS-HUMAN";
const string LINK_HINT = "Annotate > Keynote > Element, or Tag All Not Tagged with Keynote Tags, in each view.";

string SourceText(Element tag)
{
    Parameter p = tag.get_Parameter(BuiltInParameter.KEY_SOURCE_PARAM);
    return (p == null ? "" : p.AsValueString() ?? "").Trim();
}
bool Same(string have, string want)
{
    return string.Equals(have, want, System.StringComparison.OrdinalIgnoreCase);
}
bool TagTextEmpty(IndependentTag tag)
{
    string tagText = "";
    try { tagText = tag.TagText ?? ""; }
    catch (System.Exception) { tagText = ""; }
    return string.IsNullOrWhiteSpace(tagText);
}
bool KeynoteTextEmpty(IndependentTag tag)
{
    Parameter kt = tag.get_Parameter(BuiltInParameter.KEYNOTE_TEXT);
    if (kt == null) kt = tag.LookupParameter("Keynote Text");
    string keyText = kt == null ? "" : (kt.AsString() ?? kt.AsValueString() ?? "");
    return string.IsNullOrWhiteSpace(keyText);
}
// A tag the API did not link: TagText and Keynote Text are both empty. The probe is rolled back.
bool ProbeUnlinked(View view, FamilySymbol sym, Element sample, bool leader, TagOrientation orient)
{
    bool blank = true;
    using (SubTransaction sub = new SubTransaction(document))
    {
        sub.Start();
        try
        {
            IndependentTag tag = IndependentTag.Create(document, sym.Id, view.Id, new Reference(sample), leader, orient, Where(sample));
            document.Regenerate();
            blank = TagTextEmpty(tag) && KeynoteTextEmpty(tag);
        }
        catch (System.Exception) { blank = true; }
        finally { sub.RollBack(); }
    }
    return blank;
}
JArray ViewHosts()
{
    var views = new JArray();
    foreach (JObject item in (batch["ops"] as JArray ?? new JArray()).OfType<JObject>())
    {
        if ((item.Value<string>("op") ?? "") != "tag") continue;
        JArray idList = item["ids"] as JArray ?? new JArray();
        views.Add(new JObject { ["view"] = item.Value<string>("view") ?? "", ["hosts"] = idList.Count });
    }
    return views;
}
JObject NoLink()
{
    return new JObject
    {
        ["applied"] = false, ["dry_run"] = dry, ["code"] = NO_LINK, ["placed"] = 0,
        ["views"] = ViewHosts(), ["hint"] = LINK_HINT,
        ["reason"] = "A keynote tag created through the API is not linked: TagText and Keynote Text stay empty, and Key Source cannot be set. Nothing was placed.",
    };
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
    if (e == null) return "";
    Element type = e.GetTypeId() == ElementId.InvalidElementId ? null : document.GetElement(e.GetTypeId());
    string s = TextKey(type);
    if (s != "") return s;
    return TextKey(e);
}
string TypeNameOf(Element e)
{
    if (e == null) return "";
    ElementId tid = e.GetTypeId();
    if (tid != null && tid != ElementId.InvalidElementId)
    {
        Element t = document.GetElement(tid);
        if (t != null && !string.IsNullOrWhiteSpace(t.Name)) return t.Name;
    }
    return e.Name ?? "";
}
// none: the type shows the key, so a missing table row does not blank it.
// text: Keynote Text only. both: the key and the keynote text.
string TextKindOf(FamilySymbol sym)
{
    if (sym == null) return "none";
    Parameter showText = sym.LookupParameter("Show_Text");
    Parameter showKey = sym.LookupParameter("Show_Key");
    if (showText != null && showText.StorageType == StorageType.Integer)
    {
        if (showText.AsInteger() == 0) return "none";
        bool keyOn = showKey == null || showKey.StorageType != StorageType.Integer || showKey.AsInteger() != 0;
        return keyOn ? "both" : "text";
    }
    string n = (sym.Name ?? "").Trim();
    if (n.IndexOf("text", System.StringComparison.OrdinalIgnoreCase) < 0) return "none";
    bool both = n.IndexOf("key value", System.StringComparison.OrdinalIgnoreCase) >= 0
        || n.IndexOf("+", System.StringComparison.Ordinal) >= 0
        || n.IndexOf(" and ", System.StringComparison.OrdinalIgnoreCase) >= 0;
    return both ? "both" : "text";
}
void LoadKeynoteTable()
{
    if (tableLoaded) return;
    tableLoaded = true;
    try
    {
        KeynoteTable table = KeynoteTable.GetKeynoteTable(document);
        if (table == null) { tableError = "this model has no keynote table"; return; }
        var keys = new HashSet<string>(System.StringComparer.OrdinalIgnoreCase);
        foreach (KeyBasedTreeEntry entry in table.GetKeyBasedTreeEntries())
        {
            if (entry == null || string.IsNullOrWhiteSpace(entry.Key)) continue;
            keys.Add(entry.Key.Trim());
        }
        tableKeys = keys;
    }
    catch (System.Exception ex)
    {
        tableError = ex.Message;
        tableKeys = null;
    }
}
// 1 in the table, 0 not in the table, -1 the table could not be read.
int KeyInTable(string key)
{
    LoadKeynoteTable();
    if (tableKeys == null) return -1;
    return tableKeys.Contains((key ?? "").Trim()) ? 1 : 0;
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
        FamilySymbol preferred = syms.FirstOrDefault(f =>
            string.Equals(f.FamilyName, "FMC_TAG_Keynote_v2", System.StringComparison.OrdinalIgnoreCase)
            && string.Equals(f.Name, "Key Value", System.StringComparison.OrdinalIgnoreCase));
        if (preferred != null) return preferred;
        Category cat = Category.GetCategory(document, BuiltInCategory.OST_KeynoteTags);
        if (cat != null)
        {
            ElementId def = document.GetDefaultFamilyTypeId(cat.Id);
            FamilySymbol fallback = def == null || def == ElementId.InvalidElementId ? null : document.GetElement(def) as FamilySymbol;
            if (fallback != null) return fallback;
        }
        var metric = syms.Where(f => string.Equals(f.FamilyName, "M_Keynote Tag", System.StringComparison.OrdinalIgnoreCase)).ToList();
        if (metric.Count == 1) return metric[0];
        if (metric.Count > 1)
        {
            FamilySymbol keyOnly = metric.FirstOrDefault(f => TextKindOf(f) == "none");
            if (keyOnly != null) return keyOnly;
            return metric.OrderBy(f => f.Name, System.StringComparer.OrdinalIgnoreCase).First();
        }
        throw new InvalidOperationException("no keynote tag is loaded (load FMC_TAG_Keynote_v2: Key Value, or M_Keynote Tag)");
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
    try { if (!kv.Set(key)) return false; }
    catch (System.Exception) { return false; }
    document.Regenerate();
    string readBack = kv.AsString() ?? "";
    return string.Equals(readBack.Trim(), key, System.StringComparison.OrdinalIgnoreCase);
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
        View view = ViewOf(op["view"]);
        FamilySymbol sym = TagSymbol(op.Value<string>("tag_type"));
        if (!sym.IsActive) sym.Activate();
        Element sample = null;
        foreach (JToken sampleToken in (op["ids"] as JArray ?? new JArray()))
        {
            Element sampleEl = ById(sampleToken);
            if (sampleEl == null) continue;
            sample = sampleEl;
            break;
        }
        if (sample != null && ProbeUnlinked(view, sym, sample, op.Value<bool?>("leader") ?? true, (op.Value<string>("orientation") ?? "horizontal") == "vertical" ? TagOrientation.Vertical : TagOrientation.Horizontal))
            return NoLink();
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
        var emptyKey = new JArray();
        var notInTable = new JArray();
        var blank = new JArray();
        string textKind = TextKindOf(sym);
        string tagType = sym.FamilyName + ": " + sym.Name;
        JArray ids = op["ids"] as JArray ?? new JArray();
        if (ids.Count > 2000) throw new InvalidOperationException("tag takes at most 2000 elements; split the batch");
        foreach (JToken t in ids)
        {
            Element e = ById(t);
            long id = e != null ? e.Id.Value : (t.Type == JTokenType.Integer ? t.Value<long>() : 0);
            if (e == null) { skipped.Add(new JObject { ["id"] = t.ToString(), ["reason"] = "isn't in this model" }); continue; }
            string typeName = TypeNameOf(e);
            string key = "";
            Reference host = new Reference(e);
            if (want == "Material")
            {
                string matKey;
                Reference face = MaterialFace(e, view, out matKey);
                if (face == null) { skipped.Add(new JObject { ["id"] = id, ["type_name"] = typeName, ["reason"] = "no face to take a material keynote from" }); continue; }
                host = face;
                key = matKey;
            }
            else if (want == "User") key = userKey;
            else key = ElementKey(e);
            if (key == "")
            {
                emptyKey.Add(new JObject { ["id"] = id, ["type_name"] = typeName });
                skipped.Add(new JObject { ["id"] = id, ["type_name"] = typeName, ["reason"] = "skipped_empty_keynote" });
                continue;
            }
            if (textKind != "none")
            {
                int inTable = KeyInTable(key);
                if (inTable == 0)
                {
                    notInTable.Add(new JObject { ["id"] = id, ["key"] = key, ["type_name"] = typeName, ["tag_type"] = tagType });
                    if (textKind == "text")
                    {
                        skipped.Add(new JObject { ["id"] = id, ["key"] = key, ["type_name"] = typeName, ["reason"] = "key_not_in_table" });
                        continue;
                    }
                }
                else if (inTable < 0 && textKind == "text")
                {
                    string why = string.IsNullOrWhiteSpace(tableError) ? "keynote table could not be read" : "keynote table could not be read: " + tableError;
                    skipped.Add(new JObject { ["id"] = id, ["key"] = key, ["type_name"] = typeName, ["reason"] = why });
                    continue;
                }
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
            if (want == "User" && !WriteKey(tag, key))
            {
                document.Delete(tag.Id);
                skipped.Add(new JObject { ["id"] = id, ["key"] = key, ["reason"] = "Key Value could not be set" });
                continue;
            }
            document.Regenerate();
            if (TagTextEmpty(tag))
            {
                document.Delete(tag.Id);
                blank.Add(new JObject { ["id"] = id, ["key"] = key, ["type_name"] = typeName, ["tag_type"] = tagType, ["reason"] = "blank_rolled_back" });
                continue;
            }
            if (onePer) seen.Add(key);
            created.Add(tag.Id.Value);
        }
        int shownCount = created.Count - blank.Count;
        var row = new JObject
        {
            ["op"] = opsOut.Count + 1, ["kind"] = "tag", ["mode"] = mode, ["view"] = view.Name,
            ["tag_type"] = tagType, ["key_source"] = want, ["shows_keynote_text"] = textKind != "none",
            ["tagged"] = created.Count, ["shown"] = shownCount, ["created_ids"] = new JArray(created), ["skipped"] = skipped,
            ["skipped_empty_keynote"] = emptyKey, ["key_not_in_table"] = notInTable, ["blank"] = blank,
            ["counts"] = new JObject
            {
                ["created"] = created.Count, ["skipped"] = skipped.Count, ["shown"] = shownCount,
                ["skipped_empty_keynote"] = emptyKey.Count, ["key_not_in_table"] = notInTable.Count, ["blank"] = blank.Count,
            },
        };
        if (textKind != "none" && tableLoaded && tableKeys == null)
            row["keynote_table"] = new JObject { ["read"] = false, ["reason"] = string.IsNullOrWhiteSpace(tableError) ? "the keynote table could not be read" : tableError };
        if (blank.Count > 0)
            row["blank_note"] = "TagText was empty after placement. Those tags were deleted in this transaction. Nothing blank was kept.";
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
    if (name == "keynote_audit")
    {
        var views = new JArray();
        int blankTags = 0;
        foreach (IndependentTag tag in new FilteredElementCollector(document).OfClass(typeof(IndependentTag)).Cast<IndependentTag>())
        {
            if (tag.Category == null || tag.Category.Id.Value != (long)BuiltInCategory.OST_KeynoteTags) continue;
            if (!TagTextEmpty(tag)) continue;
            View owner = document.GetElement(tag.OwnerViewId) as View;
            string vname = owner == null ? "" : (owner.Name ?? "");
            JObject groupRow = null;
            foreach (JObject group in views.OfType<JObject>())
            {
                if (string.Equals(group.Value<string>("view"), vname, System.StringComparison.OrdinalIgnoreCase)) groupRow = group;
            }
            if (groupRow == null)
            {
                groupRow = new JObject { ["view"] = vname, ["count"] = 0, ["ids"] = new JArray() };
                views.Add(groupRow);
            }
            JArray bucket = groupRow["ids"] as JArray;
            bucket.Add(tag.Id.Value);
            groupRow["count"] = bucket.Count;
            blankTags++;
        }
        opsOut.Add(new JObject
        {
            ["op"] = opsOut.Count + 1, ["kind"] = "keynote_audit", ["views"] = views,
            ["blank"] = blankTags, ["deleted"] = 0,
            ["note"] = "Report only. Blank keynote tags were not deleted.",
        });
        made.Add(created);
        continue;
    }
    if (name == "keynote_clone")
    {
        bool opDry = op.Value<bool?>("dry_run") ?? true;
        Element seedEl = ById(op["seed"]);
        IndependentTag seed = seedEl as IndependentTag;
        if (seed == null) throw new InvalidOperationException("keynote_clone needs seed (the id of one linked keynote tag)");
        if (TagTextEmpty(seed))
            throw new InvalidOperationException("The seed tag has an empty TagText, so it is not a linked keynote. Make one with Annotate > Keynote > Element, then pass that tag. Nothing was copied.");
        int linked = 0, blankBack = 0, failed = 0;
        bool keeps = false;
        var createdIds = new JArray();
        var failedRows = new JArray();
        JArray hostIds = op["ids"] as JArray ?? new JArray();
        foreach (JToken t in hostIds)
        {
            Element hostEl = ById(t);
            long hostId = hostEl != null ? hostEl.Id.Value : 0;
            if (hostEl == null) { failed++; failedRows.Add(new JObject { ["id"] = t.ToString(), ["reason"] = "isn't in this model" }); continue; }
            using (SubTransaction sub = new SubTransaction(document))
            {
                sub.Start();
                try
                {
                    ICollection<ElementId> copies = ElementTransformUtils.CopyElement(document, seed.Id, XYZ.Zero);
                    ElementId copyId = null;
                    foreach (ElementId copied in copies) { copyId = copied; break; }
                    IndependentTag copy = copyId == null ? null : document.GetElement(copyId) as IndependentTag;
                    if (copy == null) { sub.RollBack(); failed++; failedRows.Add(new JObject { ["id"] = hostId, ["reason"] = "the copy was not a tag" }); continue; }
                    IList<Reference> oldRefs = copy.GetTaggedReferences();
                    if (oldRefs != null && oldRefs.Count > 0) copy.RemoveReferences(oldRefs);
                    copy.AddReferences(new List<Reference> { new Reference(hostEl) });
                    try { copy.TagHeadPosition = Where(hostEl); } catch (System.Exception) { }
                    document.Regenerate();
                    bool points = false;
                    foreach (Reference r in copy.GetTaggedReferences())
                        if (r != null && r.ElementId == hostEl.Id) points = true;
                    if (points && !TagTextEmpty(copy))
                    {
                        keeps = true;
                        linked++;
                        if (opDry) sub.RollBack();
                        else { sub.Commit(); createdIds.Add(copy.Id.Value); }
                    }
                    else { sub.RollBack(); blankBack++; }
                }
                catch (System.Exception ex)
                {
                    try { sub.RollBack(); } catch (System.Exception) { }
                    failed++;
                    failedRows.Add(new JObject { ["id"] = hostId, ["reason"] = ex.Message });
                }
            }
        }
        opsOut.Add(new JObject
        {
            ["op"] = opsOut.Count + 1, ["kind"] = "keynote_clone", ["dry_run"] = opDry,
            ["seed"] = seed.Id.Value, ["keeps_link"] = keeps,
            ["counts"] = new JObject { ["linked"] = linked, ["blank_rolled_back"] = blankBack, ["failed"] = failed },
            ["created_ids"] = createdIds, ["failed"] = failedRows,
            ["note"] = opDry ? "Dry run: copies were rolled back. Nothing was kept." : "A blank copy was rolled back. Only a tag whose TagText was not empty was kept.",
        });
        made.Add(created);
        continue;
    }
    if (name == "keynote_retag")
    {
        bool exists = false;
        try { exists = Enum.IsDefined(typeof(PostableCommand), "TagAllNotTagged"); }
        catch (System.Exception) { exists = false; }
        JArray viewTokens = op["views"] as JArray;
        if (viewTokens == null && op["view"] != null) viewTokens = new JArray(op["view"]);
        if (viewTokens == null || viewTokens.Count == 0) throw new InvalidOperationException("keynote_retag needs views (or view)");
        bool assist = op.Value<bool?>("ui_assist") ?? true;
        bool opDry = op.Value<bool?>("dry_run") ?? true;
        var queue = new JArray();
        View first = null;
        foreach (JToken vt in viewTokens)
        {
            JToken viewToken = vt.Type == JTokenType.Object ? vt["view"] : vt;
            View v = ViewOf(viewToken);
            if (first == null) first = v;
            int hosts = 0;
            JArray per = vt.Type == JTokenType.Object ? vt["ids"] as JArray : null;
            if (per != null) hosts = per.Count;
            else if (vt.Type == JTokenType.Object && vt["hosts"] != null && vt["hosts"].Type != JTokenType.Null) hosts = vt.Value<int>("hosts");
            else if (op["ids"] is JArray idList) hosts = idList.Count;
            queue.Add(new JObject { ["view"] = v.Name, ["view_id"] = v.Id.Value, ["hosts"] = hosts });
        }
        bool ready = exists && assist && !opDry && first != null;
        string activateError = "";
        if (ready)
        {
            try
            {
                UIDocument ui = new UIDocument(document);
                ui.Selection.SetElementIds(new List<ElementId>());
                ui.ActiveView = first;
            }
            catch (System.Exception ex) { ready = false; activateError = ex.Message; }
        }
        opsOut.Add(new JObject
        {
            ["op"] = opsOut.Count + 1, ["kind"] = "keynote_retag", ["code"] = NEEDS_HUMAN,
            ["command"] = "TagAllNotTagged", ["command_exists"] = exists, ["posted_ready"] = ready,
            ["ui_assist"] = assist, ["dry_run"] = opDry, ["views"] = queue,
            ["hint"] = "In the dialog, pick the Keynote Tags category and press OK. Call keynote_retag again for the next view.",
            ["reason"] = !exists ? "This Revit has no Tag All Not Tagged command. Nothing was posted."
                : !assist ? "ui_assist is false, so the command was not posted."
                : opDry ? "Dry run: the view queue is ready. Set dry_run false and ui_assist true to open the first view and post Tag All Not Tagged."
                : activateError != "" ? activateError
                : "The first view is active and nothing is selected. Tag All Not Tagged will be posted. Pick Keynote Tags and press OK.",
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
        : "A probe tag is rolled back first. If TagText and Keynote Text are empty, nothing is placed (FMC-NO-API-KEYNOTE-LINK). A blank tag is deleted and is not kept. An empty keynote is skipped_empty_keynote. A Keynote Text type whose key is missing from the keynote table is key_not_in_table.",
};
`.trim();

const MARK = "FMC-KEYNOTE-SUMMARY:";

export function isKeynoteMode(mode: unknown): mode is KeynoteMode {
  return typeof mode === "string" && (KEYNOTE_MODES as readonly string[]).includes(mode);
}

const KEYNOTE_OPS = ["keynote_legend", "place_schedule", "keynote_audit", "keynote_retag", "keynote_clone"] as const;

export function isKeynoteOp(op: KeynoteOp | null | undefined): boolean {
  if (!op || typeof op !== "object") return false;
  if ((KEYNOTE_OPS as readonly string[]).includes(op.op)) return true;
  return op.op === "tag" && isKeynoteMode(op.mode);
}

function opIsDry(op: KeynoteOp, batchDry: boolean): boolean {
  if (batchDry) return true;
  if (op.dry_run === false) return false;
  if (op.op === "keynote_clone" || op.op === "keynote_retag" || op.op === "keynote_audit") return true;
  return false;
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
    } else if (op.op === "keynote_audit") {
      /* report only */
    } else if (op.op === "keynote_retag") {
      const views = Array.isArray(op.views) ? op.views : op.view != null ? [op.view] : [];
      if (views.length === 0) return `${where}: keynote_retag needs views (or view)`;
      if (op.ui_assist != null && typeof op.ui_assist !== "boolean") return `${where}: ui_assist must be true or false`;
    } else if (op.op === "keynote_clone") {
      if (asId(op.seed) == null) return `${where}: keynote_clone needs seed (one linked keynote tag id)`;
      const ids = Array.isArray(op.ids) ? op.ids : [];
      if (ids.length === 0) return `${where}: keynote_clone needs ids (the hosts to retag)`;
      if (ids.length > 2000) return `${where}: keynote_clone takes at most 2000 hosts; split the batch`;
      if (ids.some((id) => asId(id) == null)) return `${where}: ids must be element ids`;
    } else {
      return `${where}: ${op.op} cannot share a batch with keynote tagging. Put keynote_element, keynote_material, keynote_user, keynote_legend, place_schedule, keynote_audit, keynote_retag and keynote_clone in their own modify_model call.`;
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
      const type = typeof op.tag_type === "string" && op.tag_type.trim()
        ? ` with ${op.tag_type.trim()}`
        : " with FMC_TAG_Keynote_v2: Key Value if loaded, otherwise the model's keynote tag";
      const per = op.one_per_key === false ? "" : ", one tag per key";
      const leader = op.leader === false ? "" : ", leader on";
      return `${n} Keynote tag (${src}) in ${op.view} on ${count} elements${type}${per}${leader}.`;
    }
    if (op.op === "keynote_legend") {
      const name = typeof op.name === "string" && op.name.trim() ? ` "${op.name.trim()}"` : "";
      return `${n} Keynote legend${name}${op.filtered_by_sheet ? ", filtered by sheet" : ""}.`;
    }
    if (op.op === "keynote_audit") return `${n} List keynote tags whose TagText is empty, grouped by view. Nothing is deleted.`;
    if (op.op === "keynote_retag") {
      const views = Array.isArray(op.views) ? op.views.length : op.view != null ? 1 : 0;
      return `${n} Tag All Not Tagged for ${views} view${views === 1 ? "" : "s"}. Pick Keynote Tags and press OK. Nothing is tagged by the API.`;
    }
    if (op.op === "keynote_clone") {
      const count = Array.isArray(op.ids) ? op.ids.length : 0;
      return `${n} Copy keynote tag ${op.seed} onto ${count} hosts, and roll back any copy whose TagText stays empty.`;
    }
    const pt = Array.isArray(op.point_mm) ? op.point_mm.slice(0, 2).map((n) => Math.round(Number(n))).join(", ") : "?";
    return `${n} Place ${op.schedule} on sheet ${op.sheet} at (${pt}) mm.`;
  });
  if (dryRun) lines.unshift("Dry run: Revit rolls this batch back. Nothing is kept.");
  return lines;
}

function payloadOp(op: KeynoteOp, batchDry: boolean): Record<string, unknown> {
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
  if (op.op === "keynote_audit") return { op: "keynote_audit", dry_run: true };
  if (op.op === "keynote_retag") {
    const views = Array.isArray(op.views) ? op.views : op.view != null ? [op.view] : [];
    return { op: "keynote_retag", views, ui_assist: op.ui_assist !== false, dry_run: opIsDry(op, batchDry), ...(Array.isArray(op.ids) ? { ids: op.ids } : {}) };
  }
  if (op.op === "keynote_clone") {
    return { op: "keynote_clone", seed: op.seed, ids: op.ids, dry_run: opIsDry(op, batchDry), ...(op.view != null ? { view: op.view } : {}) };
  }
  return { op: "place_schedule", sheet: op.sheet, schedule: op.schedule, point_mm: op.point_mm };
}

export function keynoteCall(ops: KeynoteOp[], dryRun: boolean, document?: string): { params: Record<string, unknown>; code: string } {
  const summaries = keynoteSummaries(ops, dryRun);
  const code = summaries.map((line) => `// ${MARK} ${line}`).join("\n") + "\n" + KEYNOTE_SCRIPT;
  const problem = screenScript(code);
  if (problem) throw new Error(problem.message);
  const ids = ops.flatMap((op) => (Array.isArray(op.ids) ? op.ids : [])).filter((id) => typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id)));
  const writes = !dryRun && ops.some((op) => {
    if (op.op === "keynote_audit" || op.op === "keynote_retag") return false;
    if (op.op === "keynote_clone") return op.dry_run === false;
    return true;
  });
  const posting = !dryRun && ops.some((op) => op.op === "keynote_retag" && op.ui_assist !== false && op.dry_run === false);
  const params: Record<string, unknown> = {
    code,
    parameters: [JSON.stringify({ dry_run: dryRun, ops: ops.map((op) => payloadOp(op, dryRun)) })],
    usings: ["Newtonsoft.Json.Linq"],
    transactionMode: writes ? "auto" : posting ? "none" : "read_only",
    dry_run: dryRun || !writes,
    purpose: "keynote tags, legend, audit, retag and clone",
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
  if (parsed?.code === "FMC-NO-API-KEYNOTE-LINK") {
    return {
      isError: true,
      body: {
        applied: false,
        dry_run: dryRun,
        code: "FMC-NO-API-KEYNOTE-LINK",
        placed: 0,
        reason: parsed.reason,
        hint: parsed.hint,
        views: parsed.views,
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
      ...(typeof parsed?.code === "string" ? { code: parsed.code } : {}),
      ...(stamped ? { document: stamped } : {}),
      ...(Array.isArray(row.warnings) && row.warnings.length ? { warnings: row.warnings } : {}),
    },
  };
}

const REFUSAL = "Put keynote_element, keynote_material, keynote_user, keynote_legend, place_schedule, keynote_audit, keynote_retag and keynote_clone in their own modify_model call. They run through the code bridge. Other ops stay on the add-in.";

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
  const shaped = shapeKeynoteResult(response, dryRun);
  if (shaped.isError) return shaped;
  const done = Array.isArray(shaped.body.ops) ? shaped.body.ops as Array<Record<string, unknown>> : [];
  const retag = done.find((op) => op.kind === "keynote_retag");
  if (!retag) return shaped;
  if (retag.posted_ready !== true || retag.command_exists !== true) {
    return { isError: true, body: { ...shaped.body, applied: false, code: "FMC-NEEDS-HUMAN", posted: false, hint: retag.hint, views: retag.views, reason: retag.reason } };
  }
  let posted: unknown;
  try { posted = await send("fmc_post_command", { command: "TagAllNotTagged", select_ids: [], ...(document ? { document } : {}) }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, body: { ...shaped.body, applied: false, code: "FMC-NEEDS-HUMAN", posted: false, command: "TagAllNotTagged", views: retag.views, hint: retag.hint, reason: message } };
  }
  const started = asRecord(posted);
  return {
    isError: true,
    body: {
      ...shaped.body,
      applied: false,
      code: "FMC-NEEDS-HUMAN",
      posted: true,
      command: "TagAllNotTagged",
      views: retag.views,
      hint: retag.hint,
      reason: "Tag All Not Tagged was posted. In the dialog, pick the Keynote Tags category and press OK. Call keynote_retag again for the next view in the queue.",
      ...(started ? { started } : {}),
    },
  };
}

/** Approval text for the bridge script: the summary lines, not the C#. */
export function keynoteApprovalLines(code: string): string[] | null {
  const lines = code.split(/\r?\n/).map((line) => {
    const at = line.indexOf(MARK);
    return at >= 0 ? line.slice(at + MARK.length).trim() : "";
  }).filter(Boolean);
  return lines.length ? lines : null;
}
