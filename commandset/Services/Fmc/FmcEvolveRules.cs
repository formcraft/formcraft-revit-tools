using System;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_family_evolve's rules on the Revit side, without the Revit API so they are tested offline (tests/evolve):
    /// which axis a plane is square to, whether a plane is unnamed, and what bind_shared_param does with what it finds.
    /// </summary>
    public static class FmcEvolveRules
    {
        /// <summary>Blank or Revit's default "Reference Plane".</summary>
        public static bool IsUnnamedPlane(string name)
        {
            string n = (name ?? "").Trim();
            return n.Length == 0 || string.Equals(n, "Reference Plane", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>The axis a plane's normal lies along (x, y or z), as name_template_plane tests it; "" for a plane at an angle.</summary>
        public static string AxisOf(double nx, double ny, double nz, double tolerance = 1e-6)
        {
            if (double.IsNaN(nx) || double.IsNaN(ny) || double.IsNaN(nz)) return "";
            if (Math.Abs(Math.Abs(nx) - 1) < tolerance) return "x";
            if (Math.Abs(Math.Abs(ny) - 1) < tolerance) return "y";
            if (Math.Abs(Math.Abs(nz) - 1) < tolerance) return "z";
            return "";
        }

        public static double Round1(double v) => Math.Round(v, 1, MidpointRounding.AwayFromZero);

        public enum BindAction { Skip, Replace, RefuseMissing, RefuseOtherGuid }

        /// <summary>
        /// bind_shared_param: the kit's GUID already in the family is a skip; no parameter of that name is refused (add_shared_param
        /// adds it); one that is shared with another GUID is refused (a person decides); a family parameter is replaced.
        /// </summary>
        public static BindAction Bind(bool kitGuidPresent, bool namedPresent, bool namedIsShared)
        {
            if (kitGuidPresent) return BindAction.Skip;
            if (!namedPresent) return BindAction.RefuseMissing;
            if (namedIsShared) return BindAction.RefuseOtherGuid;
            return BindAction.Replace;
        }

        /// <summary>A name the family parameter takes for a moment so the shared one of the same name can replace it.</summary>
        public static string TempName(string name, Func<string, bool> taken)
        {
            string stem = (name ?? "") + " (fmc evolve)";
            if (taken == null || !taken(stem)) return stem;
            for (int i = 2; i < 1000; i++) { string n = stem + " " + i; if (!taken(n)) return n; }
            throw new InvalidOperationException("No free name to step " + name + " aside");
        }
    }
}
