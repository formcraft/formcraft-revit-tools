using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    public partial class FmcModelEditHandler
    {
        /// <summary>
        /// level and grid (owner 27 Oct, the RC frame for Ogala), so a whole frame is one batch, one approval, one undo.
        /// level {name, elevation_mm}: a level, or the existing one of that name moved to the elevation. grid {name?,
        /// start_mm, end_mm}: a straight grid line, renamed when a name is given.
        /// </summary>
        private JObject FrameOp(Document doc, string name, JObject op, List<List<ElementId>> made, List<ElementId> created)
        {
            switch (name)
            {
                case "level":
                {
                    string n = op.Value<string>("name") ?? throw new InvalidOperationException("level needs name");
                    double z = Ft(op.Value<double?>("elevation_mm") ?? throw new InvalidOperationException("level needs elevation_mm"));
                    Level l = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().FirstOrDefault(x => string.Equals(x.Name, n, StringComparison.OrdinalIgnoreCase));
                    bool made1 = l == null;
                    if (made1) { l = Level.Create(doc, z); l.Name = n; created.Add(l.Id); }
                    else l.Elevation = z;
                    return new JObject { ["level"] = l.Id.Value, ["name"] = l.Name, ["created"] = made1 };
                }
                case "grid":
                {
                    XYZ s = Vec(op["start_mm"], "grid needs start_mm [x, y]"), e = Vec(op["end_mm"], "grid needs end_mm [x, y]");
                    Grid g = Grid.Create(doc, Line.CreateBound(new XYZ(s.X, s.Y, 0), new XYZ(e.X, e.Y, 0)));
                    string n = op.Value<string>("name");
                    if (!string.IsNullOrEmpty(n)) try { g.Name = n; } catch (Exception) { throw new InvalidOperationException($"grid name {n} is taken"); }
                    created.Add(g.Id);
                    return new JObject { ["grid"] = g.Id.Value, ["name"] = g.Name };
                }
                default: return null;
            }
        }

        /// <summary>
        /// size_mm on column, beam and isolated_foundation: the family's type of that size, made by duplicating the chosen
        /// type when there is none ("RC 300x300"; footings "PAD 1500x1500x400"). The size parameters are the first the
        /// type has of b/h, Width/Depth, Width/Height (sections) or Width/Length + Foundation Thickness/Thickness (pads).
        /// </summary>
        private static FamilySymbol Sized(Document doc, FamilySymbol sym, JObject op, string prefix)
        {
            if (!(op["size_mm"] is JArray sz) || sz.Count < 2) return sym;
            double a = sz[0].Value<double>(), b = sz[1].Value<double>();
            double? t = sz.Count > 2 ? sz[2].Value<double>() : (double?)null;
            string name = t.HasValue ? $"{prefix} {a:0}x{b:0}x{t:0}" : $"{prefix} {a:0}x{b:0}";
            var existing = new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
                .FirstOrDefault(x => x.Family.Id == sym.Family.Id && x.Name == name);
            if (existing != null) return existing;
            var dup = (FamilySymbol)sym.Duplicate(name);
            Parameter P(params string[] names) => names.Select(n => dup.LookupParameter(n)).FirstOrDefault(p => p != null && !p.IsReadOnly && p.StorageType == StorageType.Double);
            Parameter pa = P("b", "Width", "B"), pb = P("h", "Depth", "Height", "Length", "H", "L");
            if (pa == null || pb == null)
                throw new InvalidOperationException($"{sym.FamilyName} has no size parameters to set (has: {string.Join(", ", dup.Parameters.Cast<Parameter>().Where(p => p.StorageType == StorageType.Double && !p.IsReadOnly).Select(p => p.Definition.Name))})");
            pa.Set(a / 304.8); pb.Set(b / 304.8);
            if (t.HasValue) (P("Foundation Thickness", "Thickness", "Depth") ?? throw new InvalidOperationException($"{sym.FamilyName} has no thickness parameter")).Set(t.Value / 304.8);
            if (!dup.IsActive) dup.Activate();
            return dup;
        }
    }
}
