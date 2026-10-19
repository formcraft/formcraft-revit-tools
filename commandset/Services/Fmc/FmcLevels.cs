using System;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>The model's levels: listed lowest first, and found by name with an error that lists them.</summary>
    public static class FmcLevels
    {
        /// <summary>Every level, lowest first: name and elevation in mm.</summary>
        public static JArray List(Document doc)
        {
            return new JArray(new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation)
                .Select(l => new JObject
                {
                    ["name"] = l.Name,
                    ["elevation_mm"] = Math.Round(UnitUtils.ConvertFromInternalUnits(l.Elevation, UnitTypeId.Millimeters), 1),
                }));
        }

        /// <summary>The level of that name (any case); the error names the levels the model has.</summary>
        public static Level Find(Document doc, string name)
        {
            var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).ToList();
            return levels.FirstOrDefault(l => string.Equals(l.Name, name ?? "", StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"No level {name} in the model. Levels: " +
                    (levels.Count == 0 ? "none" : string.Join(", ", levels.Select(l => l.Name))));
        }
    }
}
