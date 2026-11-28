using System;
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
    /// fmc_fam_connector: MEP connectors in a family document. read: domain, system, flow direction, shape, size, primary
    /// flag, link and the family parameter behind each connector parameter. apply: set a connector's system, flow and
    /// associations, or add a connector on a solid's planar face (FmcDocMep's face lookup). The server validates first.
    /// </summary>
    public static class FmcFamConnector
    {
        // key used by the server → the connector parameter
        private static readonly Dictionary<string, BuiltInParameter> Keys = new Dictionary<string, BuiltInParameter>
        {
            ["diameter"] = BuiltInParameter.CONNECTOR_DIAMETER, ["radius"] = BuiltInParameter.CONNECTOR_RADIUS,
            ["width"] = BuiltInParameter.CONNECTOR_WIDTH, ["height"] = BuiltInParameter.CONNECTOR_HEIGHT,
            ["duct_flow"] = BuiltInParameter.RBS_DUCT_FLOW_PARAM, ["pipe_flow"] = BuiltInParameter.RBS_PIPE_FLOW_PARAM,
            ["voltage"] = BuiltInParameter.RBS_ELEC_VOLTAGE, ["poles"] = BuiltInParameter.RBS_ELEC_NUMBER_OF_POLES,
            ["apparent_load"] = BuiltInParameter.RBS_ELEC_APPARENT_LOAD, ["power_factor"] = BuiltInParameter.RBS_ELEC_POWER_FACTOR,
        };

        private static string DomainName(Autodesk.Revit.DB.Domain d) => d switch
        {
            Autodesk.Revit.DB.Domain.DomainPiping => "pipe", Autodesk.Revit.DB.Domain.DomainHvac => "duct",
            Autodesk.Revit.DB.Domain.DomainElectrical => "electrical", Autodesk.Revit.DB.Domain.DomainCableTrayConduit => "cable_tray",
            _ => d.ToString(),
        };

        private static string SystemOf(ConnectorElement ce)
        {
            try { return ce.SystemClassification.ToString(); }
            catch (Exception) { return null; /* not offered for this connector */ }
        }

        private static string Shape(ConnectorElement ce)
        {
            try
            {
                if (ce.Domain == Autodesk.Revit.DB.Domain.DomainElectrical) return null;
                switch (ce.Shape)
                {
                    case ConnectorProfileType.Round: return "round";
                    case ConnectorProfileType.Rectangular: return "rectangular";
                    case ConnectorProfileType.Oval: return "oval";
                }
            }
            catch (Exception) { /* not offered */ }
            return null;
        }

        private static string Flow(ConnectorElement ce)
        {
            if (ce.Domain != Autodesk.Revit.DB.Domain.DomainPiping && ce.Domain != Autodesk.Revit.DB.Domain.DomainHvac) return null;
            Parameter p = ce.get_Parameter(ce.Domain == Autodesk.Revit.DB.Domain.DomainHvac ? BuiltInParameter.RBS_DUCT_FLOW_DIRECTION_PARAM : BuiltInParameter.RBS_PIPE_FLOW_DIRECTION_PARAM);
            return p == null ? null : ((FlowDirectionType)p.AsInteger()).ToString();
        }

        public static JObject Read(Document doc)
        {
            FamilyManager fm = doc.FamilyManager;
            var list = new JArray();
            foreach (ConnectorElement ce in new FilteredElementCollector(doc).OfClass(typeof(ConnectorElement)).Cast<ConnectorElement>())
            {
                var size = new JObject();
                var assoc = new JObject();
                foreach (var kv in Keys)
                {
                    Parameter p = ce.get_Parameter(kv.Value);
                    if (p == null) continue;
                    if (p.StorageType == StorageType.Double && (kv.Key == "diameter" || kv.Key == "radius" || kv.Key == "width" || kv.Key == "height")) size[kv.Key] = FmcFamEditHandler.Mm(p.AsDouble());
                    assoc[kv.Key] = fm.GetAssociatedFamilyParameter(p)?.Definition.Name;
                }
                long? linked = null;
                try { var l = ce.GetLinkedConnectorElement(); if (l != null) linked = FmcFamEditHandler.IdOf(l.Id); } catch (Exception) { /* none */ }
                bool primary = false;
                try { primary = ce.IsPrimary; } catch (Exception) { /* not offered */ }
                list.Add(new JObject
                {
                    ["id"] = FmcFamEditHandler.IdOf(ce.Id), ["name"] = FmcDocGeometry.NameOf(ce), ["domain"] = DomainName(ce.Domain), ["system"] = SystemOf(ce),
                    ["shape"] = Shape(ce), ["flow_direction"] = Flow(ce), ["is_primary"] = primary, ["size"] = size, ["associations"] = assoc, ["linked_to"] = linked,
                });
            }
            return new JObject
            {
                ["family"] = doc.Title, ["category"] = doc.OwnerFamily?.FamilyCategory?.Name, ["connectors"] = list,
                ["parameters"] = new JArray(fm.Parameters.Cast<FamilyParameter>().Select(p => new JObject
                    { ["name"] = p.Definition.Name, ["spec"] = FmcFamEditHandler.Spec(p.Definition), ["is_instance"] = p.IsInstance, ["formula"] = string.IsNullOrEmpty(p.Formula) ? null : p.Formula })),
            };
        }

        public static JObject Apply(Document doc, JObject p)
        {
            string action = p.Value<string>("action");
            if (action == "set")
            {
                ConnectorElement ce = doc.GetElement(FmcFamEditHandler.Id(p.Value<long?>("connector") ?? -1)) as ConnectorElement
                    ?? throw new InvalidOperationException("No such connector");
                var notes = SetProperties(ce, p);
                notes.AddRange(Associate(doc, ce, p["associate"] as JObject));
                return new JObject { ["action"] = action, ["id"] = FmcFamEditHandler.IdOf(ce.Id), ["changes"] = new JArray(notes) };
            }
            if (action == "add") return Add(doc, p);
            throw new InvalidOperationException($"Unknown connector action '{action}'");
        }

        private static List<string> SetProperties(ConnectorElement ce, JObject p)
        {
            var notes = new List<string>();
            string system = p.Value<string>("system"), flow = p.Value<string>("flow_direction");
            if (!string.IsNullOrEmpty(system))
            {
                if (ce.Domain == Autodesk.Revit.DB.Domain.DomainCableTrayConduit) throw new InvalidOperationException("A cable tray or conduit connector has no system classification");
                string key = system == "Data" ? "DataCircuit" : system;
                MEPSystemClassification mc = Parse<MEPSystemClassification>(key);
                if (!ce.IsSystemClassificationValid(mc)) throw new InvalidOperationException($"{system} isn't a valid system classification for this {DomainName(ce.Domain)} connector");
                ce.SystemClassification = mc;
                notes.Add("system " + system);
            }
            if (!string.IsNullOrEmpty(flow))
            {
                BuiltInParameter bip = ce.Domain == Autodesk.Revit.DB.Domain.DomainHvac ? BuiltInParameter.RBS_DUCT_FLOW_DIRECTION_PARAM : BuiltInParameter.RBS_PIPE_FLOW_DIRECTION_PARAM;
                Parameter fp = ce.get_Parameter(bip);
                if (fp == null || fp.IsReadOnly) throw new InvalidOperationException("This connector has no flow direction to set");
                fp.Set((int)Parse<FlowDirectionType>(flow));
                notes.Add("flow " + flow);
            }
            return notes;
        }

        private static T Parse<T>(string name) where T : struct, global::System.Enum =>
            global::System.Enum.TryParse(name.Replace(" ", ""), true, out T v) ? v : throw new InvalidOperationException($"Revit has no {typeof(T).Name} '{name}'");

        private static List<string> Associate(Document doc, ConnectorElement ce, JObject map)
        {
            var notes = new List<string>();
            FamilyManager fm = doc.FamilyManager;
            foreach (var kv in map ?? new JObject())
            {
                var spec = kv.Value as JObject ?? throw new InvalidOperationException($"associate {kv.Key} is malformed");
                if (!Keys.TryGetValue(kv.Key, out BuiltInParameter bip)) throw new InvalidOperationException($"Unknown connector parameter {kv.Key}");
                Parameter cp = ce.get_Parameter(bip) ?? throw new InvalidOperationException($"The connector has no {spec.Value<string>("revit")}");
                JToken want = spec["param"];
                if (want == null || want.Type == JTokenType.Null) { fm.AssociateElementParameterToFamilyParameter(cp, null); notes.Add($"{kv.Key} association removed"); continue; }
                FamilyParameter fp = fm.get_Parameter(want.ToString()) ?? throw new InvalidOperationException($"The family has no parameter {want}");
                if (fm.GetAssociatedFamilyParameter(cp)?.Id == fp.Id) { notes.Add($"{kv.Key} already from {fp.Definition.Name}"); continue; }
                fm.AssociateElementParameterToFamilyParameter(cp, fp);
                notes.Add($"{kv.Key} from {fp.Definition.Name}");
            }
            return notes;
        }

        private static Reference Face(Document doc, JObject host)
        {
            XYZ want = (host.Value<string>("side") ?? "top") switch
            {
                "left" => XYZ.BasisX.Negate(), "right" => XYZ.BasisX, "front" => XYZ.BasisY.Negate(), "back" => XYZ.BasisY, "bottom" => XYZ.BasisZ.Negate(), _ => XYZ.BasisZ,
            };
            GenericForm form = host.Value<long?>("element_id") is long id ? doc.GetElement(FmcFamEditHandler.Id(id)) as GenericForm : FmcDocGeometry.Solid(doc, host.Value<string>("solid"));
            if (form == null) throw new InvalidOperationException("The host solid wasn't found");
            var options = new Options { ComputeReferences = true, IncludeNonVisibleObjects = true };
            foreach (GeometryObject g in form.get_Geometry(options))
                if (g is Solid s)
                    foreach (Face f in s.Faces)
                        if (f is PlanarFace pf && pf.Reference != null && pf.FaceNormal.IsAlmostEqualTo(want)) return pf.Reference;
            throw new InvalidOperationException($"The host has no {host.Value<string>("side") ?? "top"} planar face");
        }

        private static JObject Add(Document doc, JObject p)
        {
            string name = p.Value<string>("name") ?? "", domain = p.Value<string>("domain"), system = p.Value<string>("system") ?? "";
            if (name.Length > 0 && new FilteredElementCollector(doc).OfClass(typeof(ConnectorElement)).Cast<ConnectorElement>().Any(c => FmcDocGeometry.NameOf(c) == name))
                return new JObject { ["action"] = "add", ["id"] = null, ["changes"] = new JArray("skipped: a connector named " + name + " is already there") };
            Reference face = Face(doc, p["host"] as JObject ?? throw new InvalidOperationException("add needs host"));
            var size = p["size"] as JObject ?? new JObject();
            string shape = p.Value<string>("shape") ?? (domain == "cable_tray" ? "rectangular" : "round");
            bool round = shape == "round";
            ConnectorElement ce;
            switch (domain)
            {
                case "pipe": ce = ConnectorElement.CreatePipeConnector(doc, Parse<PipeSystemType>(system), face); break;
                case "duct": ce = ConnectorElement.CreateDuctConnector(doc, Parse<DuctSystemType>(system), round ? ConnectorProfileType.Round : shape == "oval" ? ConnectorProfileType.Oval : ConnectorProfileType.Rectangular, face); break;
                case "electrical": ce = ConnectorElement.CreateElectricalConnector(doc, Parse<ElectricalSystemType>(system), face); break;
                case "conduit": ce = ConnectorElement.CreateConduitConnector(doc, face); break;
                case "cable_tray": ce = ConnectorElement.CreateCableTrayConnector(doc, face); break;
                default: throw new InvalidOperationException("domain is duct, pipe, electrical, cable_tray or conduit");
            }
            if (size["diameter"] != null) ce.get_Parameter(BuiltInParameter.CONNECTOR_DIAMETER)?.Set(FmcFamEditHandler.Ft(size.Value<double>("diameter")));
            if (size["width"] != null) ce.get_Parameter(BuiltInParameter.CONNECTOR_WIDTH)?.Set(FmcFamEditHandler.Ft(size.Value<double>("width")));
            if (size["height"] != null) ce.get_Parameter(BuiltInParameter.CONNECTOR_HEIGHT)?.Set(FmcFamEditHandler.Ft(size.Value<double>("height")));
            var notes = SetProperties(ce, new JObject { ["flow_direction"] = p["flow_direction"] });
            notes.AddRange(Associate(doc, ce, p["associate"] as JObject));
            if (name.Length > 0) FmcDocGeometry.Label(ce, name);
            notes.Insert(0, $"{domain} {system} connector on the {(p["host"] as JObject)?.Value<string>("side") ?? "top"} face".Replace("  ", " "));
            return new JObject { ["action"] = "add", ["id"] = FmcFamEditHandler.IdOf(ce.Id), ["changes"] = new JArray(notes) };
        }
    }
}
