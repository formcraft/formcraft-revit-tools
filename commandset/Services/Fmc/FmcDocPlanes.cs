using System;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// F-062: names a template's unnamed reference plane by where it is, so a recipe can dimension and lock to it.
    /// Metric Door.rft's head and wall-centre planes and the beam template's b/h planes are all called "Reference Plane".
    /// The op finds the one unnamed plane square to the axis at that position (within the tolerance) and names it; a
    /// plane already named so at that position is a skip, so a second run changes nothing.
    /// </summary>
    internal static class FmcDocPlanes
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);
        private static double ToMm(double feet) => UnitUtils.ConvertFromInternalUnits(feet, UnitTypeId.Millimeters);

        public static (string, string) NameTemplatePlane(Document doc, JObject op)
        {
            string name = op.Value<string>("name") ?? throw new ArgumentException("name is needed");
            string axis = (op.Value<string>("axis") ?? "").ToLowerInvariant();
            XYZ dir = axis == "x" ? XYZ.BasisX : axis == "y" ? XYZ.BasisY : axis == "z" ? XYZ.BasisZ : throw new ArgumentException("axis is x, y or z");
            double at = Mm(op.Value<double>("at_mm")), tol = Mm(op.Value<double?>("tolerance_mm") ?? 0.5);

            var planes = new FilteredElementCollector(doc).OfClass(typeof(ReferencePlane)).Cast<ReferencePlane>()
                .Where(p => Math.Abs(Math.Abs(p.Normal.DotProduct(dir)) - 1) < 1e-6).ToList();
            bool Here(ReferencePlane p) => Math.Abs(p.BubbleEnd.DotProduct(dir) - at) <= tol;

            ReferencePlane named = planes.FirstOrDefault(p => p.Name == name);
            if (named != null)
            {
                if (Here(named)) return ("skip", "");
                throw new InvalidOperationException($"a plane named {name} is already at {axis} = {Math.Round(ToMm(named.BubbleEnd.DotProduct(dir)), 1)} mm, not {op.Value<double>("at_mm")} mm");
            }
            var unnamed = planes.Where(p => (string.IsNullOrWhiteSpace(p.Name) || p.Name == "Reference Plane") && Here(p)).ToList();
            if (unnamed.Count == 1)
            {
                unnamed[0].Name = name;
                return ("create", $"named the template's plane at {axis} = {op.Value<double>("at_mm")} mm");
            }
            string seen = string.Join(", ", planes.Select(p => $"{(string.IsNullOrWhiteSpace(p.Name) ? "(unnamed)" : p.Name)} at {Math.Round(ToMm(p.BubbleEnd.DotProduct(dir)), 1)} mm").Take(12));
            throw new InvalidOperationException(unnamed.Count == 0
                ? $"no unnamed plane square to {axis} at {op.Value<double>("at_mm")} mm (planes square to {axis}: {seen})"
                : $"{unnamed.Count} unnamed planes square to {axis} at {op.Value<double>("at_mm")} mm: give a smaller tolerance_mm");
        }
    }
}
