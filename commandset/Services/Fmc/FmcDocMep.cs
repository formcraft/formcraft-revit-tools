using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_doc MEP ops (plan B1d): a connector on a named solid's face, and a connector parameter linked to a family
    /// parameter. The system names and connector parameters are the ones today's fmc_family builder uses. A connector keeps
    /// its op name in extensible storage, so a second run skips it.
    /// </summary>
    public static class FmcDocMep
    {
        private static double Mm(double v) => UnitUtils.ConvertToInternalUnits(v, UnitTypeId.Millimeters);

        private static T? Enum<T>(string name) where T : struct, System.Enum =>
            System.Enum.TryParse(name.Replace(" ", ""), true, out T v) ? v : (T?)null;

        private static string PipeName(string classification) => classification switch
        {
            "Domestic Cold Water" => "DomesticColdWater",
            "Domestic Hot Water" => "DomesticHotWater",
            "Fire Protection Wet" => "FireProtectWet",
            "Other" => "OtherPipe",
            _ => classification.Replace(" ", ""),
        };

        public static ConnectorElement Connector(Document doc, string name) =>
            new FilteredElementCollector(doc).OfClass(typeof(ConnectorElement)).Cast<ConnectorElement>().FirstOrDefault(c => FmcDocGeometry.NameOf(c) == name);

        private static XYZ Side(string side) => side switch
        {
            "left" => XYZ.BasisX.Negate(), "right" => XYZ.BasisX, "front" => XYZ.BasisY.Negate(), "back" => XYZ.BasisY,
            "bottom" => XYZ.BasisZ.Negate(), _ => XYZ.BasisZ,
        };

        /// <summary>The solid's planar face that points to the named side (outward normal).</summary>
        private static Reference Face(Document doc, string solid, string side)
        {
            GenericForm form = FmcDocGeometry.Solid(doc, solid) ?? throw new InvalidOperationException("No solid " + solid);
            XYZ want = Side(side);
            var options = new Options { ComputeReferences = true, IncludeNonVisibleObjects = true };
            foreach (GeometryObject g in form.get_Geometry(options))
                if (g is Solid s)
                    foreach (Face f in s.Faces)
                        if (f is PlanarFace pf && pf.Reference != null && pf.FaceNormal.IsAlmostEqualTo(want)) return pf.Reference;
            throw new InvalidOperationException($"{solid} has no {side} face");
        }

        public static (string, string) AddConnector(Document doc, JObject op)
        {
            string name = op.Value<string>("name");
            if (Connector(doc, name) != null) return ("skip", "");
            Reference face = Face(doc, op.Value<string>("solid"), op.Value<string>("side") ?? "top");
            string domain = op.Value<string>("domain"), system = op.Value<string>("system") ?? "";
            ConnectorElement ce;
            switch (domain)
            {
                case "electrical":
                {
                    var est = Enum<ElectricalSystemType>(system) ?? ElectricalSystemType.PowerBalanced;
                    ce = ConnectorElement.CreateElectricalConnector(doc, est, face);
                    break;
                }
                case "pipe":
                {
                    var pst = Enum<PipeSystemType>(PipeName(system)) ?? Enum<PipeSystemType>("OtherPipe") ?? default(PipeSystemType);
                    ce = ConnectorElement.CreatePipeConnector(doc, pst, face);
                    if (op["diameter"] != null) ce.get_Parameter(BuiltInParameter.CONNECTOR_DIAMETER)?.Set(Mm(op.Value<double>("diameter")));
                    break;
                }
                case "duct":
                {
                    var dst = Enum<DuctSystemType>(system) ?? Enum<DuctSystemType>("OtherAir") ?? default(DuctSystemType);
                    bool round = op["width"] == null;
                    ce = ConnectorElement.CreateDuctConnector(doc, dst, round ? ConnectorProfileType.Round : ConnectorProfileType.Rectangular, face);
                    if (round && op["diameter"] != null) ce.get_Parameter(BuiltInParameter.CONNECTOR_DIAMETER)?.Set(Mm(op.Value<double>("diameter")));
                    if (!round)
                    {
                        ce.get_Parameter(BuiltInParameter.CONNECTOR_WIDTH)?.Set(Mm(op.Value<double>("width")));
                        if (op["height"] != null) ce.get_Parameter(BuiltInParameter.CONNECTOR_HEIGHT)?.Set(Mm(op.Value<double>("height")));
                    }
                    break;
                }
                default: throw new InvalidOperationException("domain is electrical, pipe or duct");
            }
            string flow = op.Value<string>("flow");
            if (!string.IsNullOrEmpty(flow) && Enum<FlowDirectionType>(flow) is FlowDirectionType fd)
            {
                Parameter fp = ce.get_Parameter(domain == "duct" ? BuiltInParameter.RBS_DUCT_FLOW_DIRECTION_PARAM : BuiltInParameter.RBS_PIPE_FLOW_DIRECTION_PARAM);
                if (fp != null && !fp.IsReadOnly) fp.Set((int)fd);
            }
            string load = op.Value<string>("load_classification") ?? "", loadNote = "";
            if (domain == "electrical" && load.Length > 0)
            {
                // the connector is kept either way; a classification Revit refuses is named in the op's answer, not hidden
                try { SetLoadClassification(doc, ce, load); loadNote = ", load classification " + load; }
                catch (Exception ex) { loadNote = $", load classification {load} NOT set ({ex.Message}): set it in the connector's properties"; }
            }
            FmcDocGeometry.Label(ce, name);
            return ("create", $"{domain} {system} on {op.Value<string>("solid")} {op.Value<string>("side") ?? "top"}" + loadNote);
        }

        /// <summary>The connector's Load Classification by name, made in the family if it isn't there (the name only:
        /// demand factors are the engineer's, rule 5).</summary>
        private static void SetLoadClassification(Document doc, ConnectorElement ce, string name)
        {
            Parameter p = ce.get_Parameter(BuiltInParameter.RBS_ELEC_LOAD_CLASSIFICATION)
                ?? throw new InvalidOperationException("The connector has no Load Classification (it isn't a power connector)");
            ElectricalLoadClassification lc = new FilteredElementCollector(doc).OfClass(typeof(ElectricalLoadClassification))
                .Cast<ElectricalLoadClassification>().FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase))
                ?? ElectricalLoadClassification.Create(doc, name);
            if (p.IsReadOnly || !p.Set(lc.Id)) throw new InvalidOperationException("Revit didn't take Load Classification " + name + " on the connector");
        }

        private static readonly Dictionary<string, BuiltInParameter> ConnectorParams = new Dictionary<string, BuiltInParameter>(StringComparer.OrdinalIgnoreCase)
        {
            ["Diameter"] = BuiltInParameter.CONNECTOR_DIAMETER, ["Radius"] = BuiltInParameter.CONNECTOR_RADIUS,
            ["Width"] = BuiltInParameter.CONNECTOR_WIDTH, ["Height"] = BuiltInParameter.CONNECTOR_HEIGHT,
            ["Voltage"] = BuiltInParameter.RBS_ELEC_VOLTAGE, ["Number of Poles"] = BuiltInParameter.RBS_ELEC_NUMBER_OF_POLES,
            ["Apparent Load"] = BuiltInParameter.RBS_ELEC_APPARENT_LOAD, ["Power Factor"] = BuiltInParameter.RBS_ELEC_POWER_FACTOR,
            ["Load Classification"] = BuiltInParameter.RBS_ELEC_LOAD_CLASSIFICATION, ["Pipe Flow"] = BuiltInParameter.RBS_PIPE_FLOW_PARAM,
            ["Duct Flow"] = BuiltInParameter.RBS_DUCT_FLOW_PARAM,
        };

        public static (string, string) LinkConnectorParam(Document doc, JObject op)
        {
            ConnectorElement ce = Connector(doc, op.Value<string>("connector")) ?? throw new InvalidOperationException("No connector " + op.Value<string>("connector"));
            string which = op.Value<string>("connector_param");
            if (!ConnectorParams.TryGetValue(which, out BuiltInParameter bip)) throw new InvalidOperationException("Unknown connector parameter " + which);
            Parameter p = ce.get_Parameter(bip) ?? throw new InvalidOperationException($"The connector has no {which}");
            FamilyManager fm = doc.FamilyManager;
            FamilyParameter fp = fm.get_Parameter(op.Value<string>("param")) ?? throw new InvalidOperationException("No parameter " + op.Value<string>("param"));
            if (fm.GetAssociatedFamilyParameter(p)?.Id == fp.Id) return ("skip", "");
            fm.AssociateElementParameterToFamilyParameter(p, fp);
            return ("update", which + " from " + fp.Definition.Name);
        }
    }
}
