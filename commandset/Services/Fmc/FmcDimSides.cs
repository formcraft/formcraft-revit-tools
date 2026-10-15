using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Dimension sides (F-026, F-039). A labelled dimension between two reference planes keeps, on the dimension (extensible
    /// storage, the op-name schema), which side of the first plane the second was drawn on. After any type change a plane
    /// can end on the other side of its reference while the dimension still reads the right value (Head Inner 40 mm above
    /// Head instead of below); Check finds those, so apply warns and flex fails the type.
    /// </summary>
    public static class FmcDimSides
    {
        private const string Prefix = "fmc-side|";
        private static double ToMm(double feet) => UnitUtils.ConvertFromInternalUnits(feet, UnitTypeId.Millimeters);

        /// <summary>The axis a plane faces (x, y or z) and how far b sits from a along it (feet, signed).</summary>
        private static (string Axis, double Delta) Offset(ReferencePlane a, ReferencePlane b)
        {
            XYZ n = a.Normal;
            string axis = Math.Abs(n.Z) >= Math.Abs(n.X) && Math.Abs(n.Z) >= Math.Abs(n.Y) ? "z" : Math.Abs(n.X) >= Math.Abs(n.Y) ? "x" : "y";
            XYZ d = b.BubbleEnd - a.BubbleEnd;
            return (axis, axis == "x" ? d.X : axis == "y" ? d.Y : d.Z);
        }

        /// <summary>Records the side as drawn; call before the dimension is labelled (labelling can move the plane).</summary>
        public static void Record(Dimension dim, ReferencePlane a, ReferencePlane b)
        {
            try
            {
                var (axis, delta) = Offset(a, b);
                if (Math.Abs(ToMm(delta)) < 0.5) return;
                FmcDocGeometry.Label(dim, $"{Prefix}{a.Name}|{b.Name}|{axis}|{Math.Sign(delta)}");
            }
            catch (Exception)
            {
                // a dimension that can't hold the record is reported as unrecorded, never as passed
            }
        }

        /// <summary>The labelled dimensions whose second plane is now on the other side of the first; checked and unrecorded counts.</summary>
        public static (List<JObject> Wrong, int Checked, int Unrecorded) Check(Document doc)
        {
            var wrong = new List<JObject>();
            int checkedCount = 0, unrecorded = 0;
            var planes = new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>()
                .GroupBy(p => p.Name).ToDictionary(g => g.Key, g => g.First());
            foreach (Dimension dim in new FilteredElementCollector(doc).OfClass(typeof(Dimension)).Cast<Dimension>())
            {
                FamilyParameter label;
                try { label = dim.FamilyLabel; } catch (Exception) { continue; }
                if (label == null) continue;
                string record = FmcDocGeometry.NameOf(dim);
                if (!record.StartsWith(Prefix))
                {
                    if (dim.References.Size == 2) unrecorded++;
                    continue;
                }
                string[] f = record.Substring(Prefix.Length).Split('|');
                if (f.Length < 4 || !planes.TryGetValue(f[0], out ReferencePlane a) || !planes.TryGetValue(f[1], out ReferencePlane b)) { unrecorded++; continue; }
                checkedCount++;
                int drawn = int.TryParse(f[3], out int s) ? s : 0;
                var (axis, delta) = Offset(a, b);
                double mm = Math.Round(ToMm(delta), 1);
                if (drawn != 0 && Math.Abs(mm) >= 0.5 && Math.Sign(mm) != drawn)
                    wrong.Add(new JObject { ["a"] = f[0], ["b"] = f[1], ["label"] = label.Definition.Name, ["axis"] = f[2], ["drawn"] = drawn, ["now_mm"] = mm });
            }
            return (wrong, checkedCount, unrecorded);
        }
    }
}
