// Catalogue meshes: a staged family's Fine geometry, closed, the family alone (no host wall, clearance, envelope,
// connectors or light path), as triangles with each material's colour, transparency and shininess, in mm.
// parameters[0] = the family file, parameters[1] = the output JSON. Read-only: the family is closed without saving.
var app = document.Application;
string path = parameters[0].ToString(), outFile = parameters[1].ToString();
Document fam = app.OpenDocumentFile(path);
var sb = new System.Text.StringBuilder();
int tris = 0, parts = 0;
var skipped = new List<string>();
try
{
    using (var tg = new TransactionGroup(fam, "FMC catalogue mesh"))
    {
        tg.Start();
        using (var t = new Transaction(fam, "closed"))
        {
            t.Start();
            FamilyManager fm = fam.FamilyManager;
            if (fm.CurrentType == null && fm.Types.Size > 0) fm.CurrentType = fm.Types.Cast<FamilyType>().First();
            foreach (FamilyParameter fp in fm.Parameters)
                if (fp.Definition.Name == "Open" && fp.StorageType == StorageType.Integer && string.IsNullOrEmpty(fp.Formula) && fm.CurrentType != null) fm.Set(fp, 0);
            t.Commit();
        }
        Func<string, bool> aid = n => n != null && (n.StartsWith("Clearance", StringComparison.OrdinalIgnoreCase) || n.StartsWith("Coarse", StringComparison.OrdinalIgnoreCase)
            || n.IndexOf("Envelope", StringComparison.OrdinalIgnoreCase) >= 0 || n.IndexOf("Light Path", StringComparison.OrdinalIgnoreCase) >= 0
            || n.IndexOf("Connector", StringComparison.OrdinalIgnoreCase) >= 0 || n.StartsWith("CN ", StringComparison.OrdinalIgnoreCase));
        var opt = new Options { DetailLevel = ViewDetailLevel.Fine, ComputeReferences = false, IncludeNonVisibleObjects = false };
        double mm = 304.8;
        sb.Append("{\"family\":\"").Append(fam.Title.Replace(".rfa", "")).Append("\",\"parts\":[");
        Action<Solid, Transform, Element, string> addSolid = null;
        Func<ElementId, string> look = id =>
        {
            var m = fam.GetElement(id) as Material;
            if (m == null) return "\"name\":\"\",\"rgb\":[200,200,200],\"alpha\":1,\"shine\":32";
            var c = m.Color; double a = 1 - m.Transparency / 100.0;
            return "\"name\":\"" + m.Name.Replace("\"", "") + "\",\"rgb\":[" + c.Red + "," + c.Green + "," + c.Blue + "],\"alpha\":" + a.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"shine\":" + m.Shininess;
        };
        addSolid = (s, tf, owner, name) =>
        {
            if (s == null || s.Faces.Size == 0 || s.Volume <= 0) return;
            foreach (Face f in s.Faces)
            {
                Mesh mesh = f.Triangulate(1.0);
                if (mesh == null || mesh.NumTriangles == 0) continue;
                if (parts++ > 0) sb.Append(",");
                sb.Append("{\"of\":\"").Append((name ?? "").Replace("\"", "")).Append("\",").Append(look(f.MaterialElementId)).Append(",\"v\":[");
                for (int i = 0; i < mesh.NumTriangles; i++)
                {
                    MeshTriangle tri = mesh.get_Triangle(i);
                    for (int k = 0; k < 3; k++)
                    {
                        XYZ p = tf.OfPoint(tri.get_Vertex(k));
                        if (i > 0 || k > 0) sb.Append(",");
                        sb.Append(Math.Round(p.X * mm, 2).ToString(System.Globalization.CultureInfo.InvariantCulture)).Append(",")
                          .Append(Math.Round(p.Y * mm, 2).ToString(System.Globalization.CultureInfo.InvariantCulture)).Append(",")
                          .Append(Math.Round(p.Z * mm, 2).ToString(System.Globalization.CultureInfo.InvariantCulture));
                    }
                    tris++;
                }
                sb.Append("]}");
            }
        };
        Action<GeometryElement, Transform, Element, string> walk = null;
        walk = (ge, tf, owner, name) =>
        {
            if (ge == null) return;
            foreach (GeometryObject go in ge)
            {
                var gs = fam.GetElement(go.GraphicsStyleId) as GraphicsStyle;
                if (gs != null && aid(gs.GraphicsStyleCategory?.Name)) continue;
                if (go is Solid s) addSolid(s, tf, owner, name);
                else if (go is GeometryInstance gi) walk(gi.GetSymbolGeometry(), tf.Multiply(gi.Transform), owner, name);
            }
        };
        bool hosted = fam.OwnerFamily.get_Parameter(BuiltInParameter.FAMILY_HOSTING_BEHAVIOR)?.AsInteger() > 0;
        foreach (Element e in new FilteredElementCollector(fam).WhereElementIsNotElementType())
        {
            if (!(e is GenericForm || e is FamilyInstance)) continue;
            // a face-based template's host stand-in (the ceiling or wall the family sits on) isn't the product
            var hostCats = new[] { (int)BuiltInCategory.OST_Ceilings, (int)BuiltInCategory.OST_Walls, (int)BuiltInCategory.OST_Floors, (int)BuiltInCategory.OST_Roofs };
            if (e.Category != null && hostCats.Contains((int)e.Category.Id.Value)) { skipped.Add(e.Name + " (host)"); continue; }
            if (e is GenericForm && (e.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM)?.AsElementId() ?? ElementId.InvalidElementId) == ElementId.InvalidElementId
                && e.get_Parameter(BuiltInParameter.FAMILY_ELEM_SUBCATEGORY)?.AsElementId() == ElementId.InvalidElementId && e.Name == "Extrusion" && hosted) { skipped.Add("host stand-in"); continue; }
            string name = e.Name;
            var sub = e.get_Parameter(BuiltInParameter.FAMILY_ELEM_SUBCATEGORY);
            string subName = sub == null ? null : (fam.GetElement(sub.AsElementId()) as GraphicsStyle)?.GraphicsStyleCategory?.Name;
            if (aid(name) || aid(subName)) { skipped.Add(name); continue; }
            var vis = e.get_Parameter(BuiltInParameter.IS_VISIBLE_PARAM);
            if (vis != null && vis.AsInteger() == 0) { skipped.Add(name + " (hidden)"); continue; }
            if (e is GenericForm gf)
            {
                var fv = gf.GetVisibility();
                if (fv != null && !fv.IsShownInFine) { skipped.Add(name + " (not Fine)"); continue; }
            }
            walk(e.get_Geometry(opt), Transform.Identity, e, name);
        }
        sb.Append("]}");
        tg.RollBack();
    }
    System.IO.File.WriteAllText(outFile, sb.ToString());
}
finally { try { fam.Close(false); } catch (Exception) { } }
return parts + " faces, " + tris + " triangles; skipped " + skipped.Count + ": " + string.Join(", ", skipped.Take(12));
