using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_model_edit's family ops (owner 26 Oct, tools group 4), in the Family Editor: extrusion, blend, revolve, sweep
    /// (solid or void), family_param, family_type, family_category, save_family, load_into_project. reference_plane and
    /// dimension work in families and projects. Planes: "XY" (plan, default), "XZ" (front), "YZ" (side) with offset_mm,
    /// or a reference plane by name. Profile points are [u, v] in that plane: XY = [x, y], XZ = [x, z], YZ = [y, z].
    /// </summary>
    public partial class FmcModelEditHandler
    {
        private readonly List<Func<JObject>> _after = new List<Func<JObject>>();

        private JObject FamilyOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "extrusion":
                {
                    Fam(doc, name);
                    var (sp, map) = PlaneOf(doc, op);
                    Extrusion x = doc.FamilyCreate.NewExtrusion(op.Value<bool?>("solid") ?? true, Profile(op["outline_mm"] ?? op["loops_mm"], map, op["loops_mm"] != null), sp, Ft(op.Value<double?>("end_mm") ?? 1000));
                    if (op["start_mm"] != null) x.StartOffset = Ft(op.Value<double>("start_mm"));
                    return Formed(doc, x, op, created);
                }
                case "blend":
                {
                    Fam(doc, name);
                    var (sp, map) = PlaneOf(doc, op);
                    Blend b = doc.FamilyCreate.NewBlend(op.Value<bool?>("solid") ?? true, Profile(op["top_mm"], map, false).get_Item(0), Profile(op["bottom_mm"], map, false).get_Item(0), sp);
                    b.TopOffset = Ft(op.Value<double?>("height_mm") ?? 1000);
                    return Formed(doc, b, op, created);
                }
                case "revolve":
                {
                    Fam(doc, name);
                    var (sp, map) = PlaneOf(doc, op, "XZ");
                    var ax = (op["axis_mm"] as JArray ?? throw new InvalidOperationException("revolve needs axis_mm [[u, v], [u, v]] in the profile's plane")).OfType<JArray>().Select(p => map(p[0].Value<double>(), p[1].Value<double>())).ToList();
                    Revolution r = doc.FamilyCreate.NewRevolution(op.Value<bool?>("solid") ?? true, Profile(op["outline_mm"], map, false), sp, Line.CreateBound(ax[0], ax[1]),
                        (op.Value<double?>("start_deg") ?? 0) * Math.PI / 180, (op.Value<double?>("end_deg") ?? 360) * Math.PI / 180);
                    return Formed(doc, r, op, created);
                }
                case "sweep":
                {
                    // path_mm in plan; profile_mm [u, v] at the path's start: u across the path (to its right), v up
                    Fam(doc, name);
                    var path = Points(op["path_mm"], "sweep needs path_mm, a polyline in plan");
                    var curves = new CurveArray();
                    for (int i = 0; i + 1 < path.Count; i++) curves.Append(Line.CreateBound(path[i], path[i + 1]));
                    XYZ along = (path[1] - path[0]).Normalize(), across = along.CrossProduct(XYZ.BasisZ).Normalize();
                    Func<double, double, XYZ> map = (u, v) => path[0] + across * Ft(u) + XYZ.BasisZ * Ft(v);
                    SweepProfile prof = doc.Application.Create.NewCurveLoopsProfile(Profile(op["profile_mm"], map, false));
                    SketchPlane sp = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisZ, new XYZ(0, 0, path[0].Z)));
                    Sweep sw = doc.FamilyCreate.NewSweep(op.Value<bool?>("solid") ?? true, curves, sp, prof, 0, ProfilePlaneLocation.Start);
                    return Formed(doc, sw, op, created);
                }
                case "family_param":
                {
                    Fam(doc, name);
                    FamilyManager fm = doc.FamilyManager;
                    if (fm.CurrentType == null) fm.NewType("Type 1");
                    string pname = op.Value<string>("name") ?? throw new InvalidOperationException("family_param needs name");
                    FamilyParameter p = fm.get_Parameter(pname) ?? fm.AddParameter(pname, Group(op.Value<string>("group")), Spec(op.Value<string>("type") ?? "Length"), op.Value<bool?>("instance") ?? false);
                    if (op["formula"] != null) fm.SetFormula(p, op.Value<string>("formula"));
                    else if (op["value"] != null) SetFamilyValue(doc, fm, p, op["value"]);
                    return new JObject { ["param"] = p.Definition.Name, ["instance"] = p.IsInstance };
                }
                case "family_type":
                {
                    Fam(doc, name);
                    FamilyManager fm = doc.FamilyManager;
                    string tname = op.Value<string>("name") ?? throw new InvalidOperationException("family_type needs name");
                    FamilyType t = fm.Types.Cast<FamilyType>().FirstOrDefault(x => x.Name == tname) ?? fm.NewType(tname);
                    fm.CurrentType = t;
                    if (op["params"] is JObject ps)
                        foreach (var kv in ps) SetFamilyValue(doc, fm, fm.get_Parameter(kv.Key) ?? throw new InvalidOperationException($"no family parameter {kv.Key}"), kv.Value);
                    return new JObject { ["type"] = tname };
                }
                case "family_category":
                {
                    Fam(doc, name);
                    ElementId cat = Categories(doc, new JArray(op.Value<string>("category") ?? throw new InvalidOperationException("family_category needs category")))[0];
                    doc.OwnerFamily.FamilyCategory = Category.GetCategory(doc, cat);
                    return new JObject { ["category"] = doc.OwnerFamily.FamilyCategory.Name };
                }
                case "reference_plane":
                {
                    var p = Points(new JArray(op["start_mm"], op["end_mm"]), "reference_plane needs start_mm and end_mm");
                    View v = op["view"] != null ? ViewOf(doc, op["view"], made) : doc.ActiveView;
                    XYZ cut = op["cut_mm"] != null ? Vec(op["cut_mm"], "cut_mm is a direction [x, y, z]") : XYZ.BasisZ;
                    Autodesk.Revit.Creation.ItemFactoryBase f = doc.IsFamilyDocument ? (Autodesk.Revit.Creation.ItemFactoryBase)doc.FamilyCreate : doc.Create;
                    ReferencePlane rp = f.NewReferencePlane(p[0], p[1], cut, v);
                    if (op["name"] != null) rp.Name = op.Value<string>("name");
                    created.Add(rp.Id);
                    return new JObject { ["plane"] = rp.Id.Value, ["name"] = rp.Name };
                }
                case "dimension":
                {
                    // refs: reference planes (by name), grids, levels or element ids; line_mm where the dimension line goes
                    View v = op["view"] != null ? ViewOf(doc, op["view"], made) : doc.ActiveView;
                    var refs = new ReferenceArray();
                    foreach (JToken t in op["refs"] as JArray ?? throw new InvalidOperationException("dimension needs refs (two or more)")) refs.Append(RefOf(doc, t, made));
                    var l = Points(op["line_mm"], "dimension needs line_mm [[x, y], [x, y]]");
                    Autodesk.Revit.Creation.ItemFactoryBase f = doc.IsFamilyDocument ? (Autodesk.Revit.Creation.ItemFactoryBase)doc.FamilyCreate : doc.Create;
                    Dimension d = f.NewDimension(v, Line.CreateBound(l[0], l[1]), refs);
                    if (op["label"] != null) d.FamilyLabel = doc.FamilyManager.get_Parameter(op.Value<string>("label")) ?? throw new InvalidOperationException($"no family parameter {op.Value<string>("label")}");
                    if (op.Value<bool?>("equal") == true) d.AreSegmentsEqual = true;
                    created.Add(d.Id);
                    return new JObject { ["dimension"] = d.Id.Value };
                }
                case "save_family":
                {
                    Fam(doc, name);
                    string path = op.Value<string>("path");
                    if (path != null && !path.EndsWith(".rfa", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("save_family path must end in .rfa");
                    // Project-folder gate (28 Nov 2026): the path must be inside the family's or its project's folder, never
                    // the kit, standards, shared state, protected_roots or a forbidden project; an existing file is replaced
                    // only with overwrite: true. Checked now and again right before the save.
                    bool overwrite = op.Value<bool?>("overwrite") ?? false;
                    string project = op.Value<string>("project");
                    string archivePath = op.Value<string>("archive_path");
                    string target = FamilySaveTarget(doc, path, project, overwrite, archivePath);
                    _after.Add(() =>
                    {
                        string t = FamilySaveTarget(doc, path, project, overwrite, archivePath);
                        if (path == null || FmcTarget.SamePath(t, doc.PathName ?? "")) doc.Save();
                        else doc.SaveAs(t, new SaveAsOptions { OverwriteExistingFile = overwrite, MaximumBackups = 1 });
                        return new JObject { ["saved"] = doc.PathName };
                    });
                    return new JObject { ["save"] = target };
                }
                case "load_into_project":
                {
                    Fam(doc, name);
                    string title = op.Value<string>("project");
                    // Project-folder gate (28 Nov 2026): overwrite defaults to false; the target project must be saved, not a
                    // forbidden project or a workshared central, and inside its own jail; a saved family must be readable
                    // from the project's folder or read_only_roots (the kit).
                    bool overwrite = op.Value<bool?>("overwrite") ?? false;
                    _after.Add(() =>
                    {
                        var projects = FmcPathJail.OpenProjects(doc.Application);
                        Document target = FmcPathJail.ProjectFor(doc.Application, title)
                            ?? throw new InvalidOperationException(title == null ? (projects.Count == 0 ? "no project is open" : "several projects are open: name project") : $"{title} isn't open");
                        FmcPathJail.RequireLoadTarget(target);
                        if (!string.IsNullOrEmpty(doc.PathName)) FmcPathJail.Require("read", doc.PathName, FmcPathJail.For(doc, target), "family");
                        // BSF-3: a family already in the project is refused without overwrite: true (FMC-FAM-EXISTS with the
                        // preview); with it, the project's old family is archived to archive_path first.
                        var incoming = doc.FamilyManager.Types.Cast<FamilyType>().Select(t => t.Name).ToList();
                        JObject archived = FmcFamilySafe.BeforeLoad(target, doc.Title.EndsWith(".rfa", StringComparison.OrdinalIgnoreCase) ? doc.Title.Substring(0, doc.Title.Length - 4) : doc.Title,
                            overwrite, op.Value<string>("archive_path"), incoming);
                        Family fam = doc.LoadFamily(target, new LoadOptions(archived != null));
                        return new JObject { ["loaded_into"] = target.Title, ["family"] = fam?.Name ?? doc.Title, ["overwritten"] = archived != null, ["archived"] = archived?["archived"], ["preview"] = archived?["preview"] };
                    });
                    return new JObject { ["load"] = title ?? "the open project" };
                }
                default: return StructureOp(doc, name, op, made, created) ?? MepOp(doc, name, op, made, created) ?? MoreOp(doc, name, op, made, created) ?? ManageOp(doc, name, op, made, created) ?? ExtraOp(doc, name, op, made, created) ?? SpecialOp(doc, name, op, made, created);
            }
        }

        /// <summary>save_family's target through the project-folder gate (FmcPathJail); throws the refusal.</summary>
        private static string FamilySaveTarget(Document doc, string path, string project, bool overwrite, string archivePath = null)
        {
            FmcPathJail.Roots roots = FmcPathJail.ForFamily(doc, project);
            if (path == null)
            {
                if (string.IsNullOrEmpty(doc.PathName)) throw new InvalidOperationException("[" + FmcPathJail.NoRoot + "] the family is not saved yet: give save_family a path (.rfa) in the project folder");
                return FmcPathJail.Require("write", doc.PathName, roots, "save_family");
            }
            string c = FmcPathJail.Require("write", path, roots, "path");
            // BSF-3: another existing .rfa is replaced only with overwrite: true and the server's archive of it
            if (File.Exists(c) && !FmcTarget.SamePath(c, doc.PathName ?? "")) FmcFamilySafe.RequireFileArchived(c, overwrite, archivePath, roots);
            return c;
        }

        private static void Fam(Document doc, string op)
        {
            if (!doc.IsFamilyDocument) throw new InvalidOperationException($"{op} works in the Family Editor: open the family first (new_family makes one)");
        }

        private static JObject Formed(Document doc, GenericForm f, JObject op, List<ElementId> created)
        {
            if (op["material"] != null)
            {
                Parameter m = f.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM);
                FamilyParameter fp = doc.FamilyManager.get_Parameter(op.Value<string>("material"));
                if (fp != null && m != null) doc.FamilyManager.AssociateElementParameterToFamilyParameter(m, fp);
                else m?.Set(MaterialId(doc, op.Value<string>("material")));
            }
            if (op["subcategory"] != null)
            {
                Category sub = doc.OwnerFamily.FamilyCategory.SubCategories.Cast<Category>().FirstOrDefault(c => string.Equals(c.Name, op.Value<string>("subcategory"), StringComparison.OrdinalIgnoreCase))
                    ?? doc.Settings.Categories.NewSubcategory(doc.OwnerFamily.FamilyCategory, op.Value<string>("subcategory"));
                f.Subcategory = sub;
            }
            created.Add(f.Id);
            return new JObject { ["form"] = f.Id.Value, ["solid"] = f.IsSolid };
        }

        private static (SketchPlane, Func<double, double, XYZ>) PlaneOf(Document doc, JObject op, string fallback = "XY")
        {
            string plane = op.Value<string>("plane") ?? fallback;
            double off = Ft(op.Value<double?>("offset_mm") ?? 0);
            switch (plane.ToUpperInvariant())
            {
                case "XY": return (SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisZ, new XYZ(0, 0, off))), (u, v) => new XYZ(Ft(u), Ft(v), off));
                case "XZ": return (SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisY, new XYZ(0, off, 0))), (u, v) => new XYZ(Ft(u), off, Ft(v)));
                case "YZ": return (SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisX, new XYZ(off, 0, 0))), (u, v) => new XYZ(off, Ft(u), Ft(v)));
            }
            ReferencePlane rp = new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>().FirstOrDefault(r => string.Equals(r.Name, plane, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"plane {plane}: use XY, XZ, YZ or a reference plane's name");
            Plane p = rp.GetPlane();
            XYZ ux = p.XVec, vy = p.YVec, o = p.Origin + p.Normal * off;
            return (SketchPlane.Create(doc, rp.Id), (u, v) => o + ux * Ft(u) + vy * Ft(v));
        }

        /// <summary>Closed loops of [u, v] points mapped into the sketch plane (several when loops is true: holes after the outside).</summary>
        private static CurveArrArray Profile(JToken t, Func<double, double, XYZ> map, bool loops)
        {
            var raw = t as JArray ?? throw new InvalidOperationException("the op needs a profile: outline_mm [[u, v], ...] (or loops_mm)");
            var all = new CurveArrArray();
            foreach (JArray loop in loops ? raw.OfType<JArray>() : new[] { raw })
            {
                var pts = loop.OfType<JArray>().Select(p => map(p[0].Value<double>(), p[1].Value<double>())).ToList();
                if (pts.Count < 3) throw new InvalidOperationException("a profile loop needs three or more points");
                var ca = new CurveArray();
                for (int i = 0; i < pts.Count; i++) ca.Append(Line.CreateBound(pts[i], pts[(i + 1) % pts.Count]));
                all.Append(ca);
            }
            return all;
        }

        private static Reference RefOf(Document doc, JToken t, List<List<ElementId>> made)
        {
            string s = t.ToString();
            Element e = s.StartsWith("$") || long.TryParse(s, out _) ? doc.GetElement(Ref(doc, t, made))
                : new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).FirstOrDefault(r => string.Equals(r.Name, s, StringComparison.OrdinalIgnoreCase))
                  ?? new FilteredElementCollector(doc).OfClass(typeof(Grid)).FirstOrDefault(g => g.Name == s)
                  ?? new FilteredElementCollector(doc).OfClass(typeof(Level)).FirstOrDefault(l => l.Name == s);
            if (e is ReferencePlane rp) return rp.GetReference();
            if (e is Grid || e is Level) return new Reference(e);
            throw new InvalidOperationException($"{s}: dimension references are reference planes, grids or levels");
        }

        private static ForgeTypeId Group(string g) => (g ?? "dimensions").ToLowerInvariant() switch
        {
            "text" => GroupTypeId.Text, "materials" => GroupTypeId.Materials, "identity" => GroupTypeId.IdentityData,
            "constraints" => GroupTypeId.Constraints, "data" => GroupTypeId.Data, "graphics" => GroupTypeId.Graphics,
            _ => GroupTypeId.Geometry,
        };

        private static ForgeTypeId Spec(string t) => t.ToLowerInvariant() switch
        {
            "text" => SpecTypeId.String.Text, "number" => SpecTypeId.Number, "integer" => SpecTypeId.Int.Integer,
            "yesno" => SpecTypeId.Boolean.YesNo, "material" => SpecTypeId.Reference.Material, "angle" => SpecTypeId.Angle,
            "area" => SpecTypeId.Area, "volume" => SpecTypeId.Volume, "length" => SpecTypeId.Length,
            _ => throw new InvalidOperationException($"{t}: type is Length, Text, Number, Integer, YesNo, Material, Angle, Area or Volume"),
        };

        private static void SetFamilyValue(Document doc, FamilyManager fm, FamilyParameter p, JToken v)
        {
            switch (p.StorageType)
            {
                case StorageType.Double:
                    double d = v.Value<double>();
                    fm.Set(p, p.Definition.GetDataType() == SpecTypeId.Length ? Ft(d) : p.Definition.GetDataType() == SpecTypeId.Angle ? d * Math.PI / 180 : d); break;
                case StorageType.Integer:
                    string s = v.ToString().ToLowerInvariant();
                    fm.Set(p, s == "true" || s == "yes" ? 1 : s == "false" || s == "no" ? 0 : int.Parse(s)); break;
                case StorageType.ElementId: fm.Set(p, MaterialId(doc, v.ToString())); break;
                default: fm.Set(p, v.ToString()); break;
            }
        }

        private sealed class LoadOptions : IFamilyLoadOptions
        {
            private readonly bool _overwrite;
            public LoadOptions(bool overwrite) { _overwrite = overwrite; }
            public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues) { overwriteParameterValues = _overwrite; return _overwrite; }
            public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues)
            { source = FamilySource.Family; overwriteParameterValues = _overwrite; return _overwrite; }
        }
    }

    /// <summary>
    /// fmc_family_new (owner 26 Oct): a new family from a Revit family template (by name, e.g. "Metric Generic Model", or a
    /// path), saved as path (.rfa) and opened in the Family Editor, so modify_model's family ops can build it.
    /// </summary>
    public class FmcFamilyNewHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft new family";

        public void Execute(UIApplication app)
        {
            Result = new JObject(); Error = "";
            try
            {
                string tpl = Parameters.Value<string>("template") ?? "Metric Generic Model";
                string path = Parameters.Value<string>("path") ?? throw new InvalidOperationException("path is needed: where to save the new family (.rfa)");
                if (!path.EndsWith(".rfa", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("path must end in .rfa");
                // Project-folder gate (28 Nov 2026): the new family is saved inside the named (or only open) project's
                // folder; the template must be readable from that project or read_only_roots (the kit). ProgramData is not
                // a read root (Q5): until the templates are copied into the kit, name a template inside read_only_roots.
                bool overwrite = Parameters.Value<bool?>("overwrite") ?? false;
                Document project = FmcPathJail.ProjectFor(app.Application, Parameters.Value<string>("project"));
                FmcPathJail.Roots roots = FmcPathJail.For(project);
                string target = FmcPathJail.Require("write", path, roots, "path");
                // BSF-3: an existing .rfa is replaced only with overwrite: true and the server's archive of it
                string archivedFile = File.Exists(target) ? FmcFamilySafe.RequireFileArchived(target, overwrite, Parameters.Value<string>("archive_path"), roots) : null;
                string file = File.Exists(tpl) ? tpl : FindTemplate(app.Application.FamilyTemplatePath, tpl)
                    ?? throw new InvalidOperationException($"no family template {tpl} under {app.Application.FamilyTemplatePath}");
                file = FmcPathJail.Require("read", file, roots, "template");
                // NF-2: a dry run checks the path, the template and the overwrite, and writes nothing
                if (Parameters.Value<bool?>("dry_run") == true)
                {
                    Result = new JObject { ["dry_run"] = true, ["would_save"] = target, ["template"] = file, ["exists"] = File.Exists(target), ["archived"] = archivedFile,
                        ["next"] = "Run again with dry_run false to make it" };
                    return;
                }
                Document fam = app.Application.NewFamilyDocument(file);
                target = FmcPathJail.Require("write", path, roots, "path");
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                fam.SaveAs(target, new SaveAsOptions { OverwriteExistingFile = archivedFile != null, MaximumBackups = 1 });
                path = target;
                fam.Close(false);
                app.OpenAndActivateDocument(path);
                Result = new JObject { ["family"] = path, ["template"] = file, ["next"] = "It's open in the Family Editor: build it with modify_model (extrusion, family_param, ...), then save_family and load_into_project" };
            }
            catch (Exception e) { Error = e.Message; }
            finally { _done.Set(); }
        }

        private static string FindTemplate(string root, string name)
        {
            if (string.IsNullOrEmpty(root) || !Directory.Exists(root)) return null;
            string want = name.EndsWith(".rft", StringComparison.OrdinalIgnoreCase) ? name : name + ".rft";
            return Directory.EnumerateFiles(root, "*.rft", SearchOption.AllDirectories).FirstOrDefault(f => string.Equals(Path.GetFileName(f), want, StringComparison.OrdinalIgnoreCase));
        }
    }
}
