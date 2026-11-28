using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// One transaction for a join plan. At most 50 operations.
    /// Pinned elements are reported and left alone. Elements another user owns, or that are not current, are skipped.
    /// CheckoutElements is never called. Nothing is saved or synced.
    /// The active document and the active view are not changed.
    /// </summary>
    public class FmcJoinsApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private const double Mm = 304.8;
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft joins apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            string titleBefore = app.ActiveUIDocument?.Document?.Title ?? "";
            string viewBefore = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_joins_apply needs document: a title or a full path. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsFamilyDocument) throw new InvalidOperationException("[FMC-JOINS] fmc_joins_apply runs on a project model.");
                    Refuse(doc);
                    int cap = Parameters.Value<int?>("max_ops") ?? 50;
                    if (cap < 1) cap = 1;
                    if (cap > 50) cap = 50;
                    var ops = (Parameters["ops"] as JArray ?? new JArray()).OfType<JObject>().Take(cap).ToList();
                    var done = new JArray();
                    var skipped = new JArray();
                    int changed = 0;
                    using (var transaction = new Transaction(doc, "Formcraft joins"))
                    {
                        transaction.Start();
                        foreach (JObject op in ops)
                        {
                            try
                            {
                                JObject row = ApplyOne(doc, op, skipped);
                                done.Add(row);
                                if (row.Value<bool?>("ok") == true) changed++;
                            }
                            catch (Exception ex)
                            {
                                done.Add(new JObject { ["op"] = op.Value<string>("op") ?? "", ["ok"] = false, ["error"] = ex.Message });
                            }
                        }
                        transaction.Commit();
                    }
                    Result["ok"] = true;
                    Result["applied"] = changed > 0;
                    Result["changed"] = changed;
                    Result["ops"] = done;
                    Result["skipped"] = skipped;
                    Result["saved"] = false;
                    Result["synced"] = false;
                    Result["read_only"] = false;
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                    Result["is_central"] = false;
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally
            {
                string titleAfter = app.ActiveUIDocument?.Document?.Title ?? "";
                string viewAfter = app.ActiveUIDocument?.ActiveView?.UniqueId ?? "";
                if (Result != null && string.IsNullOrEmpty(Error))
                    Result["active_unchanged"] = titleBefore == titleAfter && viewBefore == viewAfter;
                _done.Set();
            }
        }

        private void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_joins.");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by fmc_joins.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }

        private static JObject ApplyOne(Document doc, JObject op, JArray skipped)
        {
            string name = (op.Value<string>("op") ?? "").Trim();
            var ids = Ids(op);
            var kept = new List<ElementId>();
            var held = new JArray();
            if (ids.Count > 0) FmcCheckout.Partition(doc, ids, kept, held);
            foreach (JToken row in held) skipped.Add(row);
            if (ids.Count > 0 && kept.Count != ids.Count)
                return new JObject { ["op"] = name, ["ok"] = false, ["skipped"] = held };
            foreach (ElementId id in kept)
            {
                Element element = doc.GetElement(id);
                if (element != null && element.Pinned)
                    return new JObject { ["op"] = name, ["ok"] = false, ["code"] = "JOIN-PINNED", ["id"] = id.Value.ToString() };
            }
            switch (name)
            {
                case "allow_join":
                    Wall allow = WallOf(doc, kept);
                    WallUtils.AllowWallJoinAtEnd(allow, End(op));
                    return Ok(name, kept.Count);
                case "join":
                    if (kept.Count < 2) throw new InvalidOperationException("[FMC-JOINS] join needs two elements.");
                    Element left = doc.GetElement(kept[0]);
                    Element right = doc.GetElement(kept[1]);
                    if (!JoinGeometryUtils.AreElementsJoined(doc, left, right)) JoinGeometryUtils.JoinGeometry(doc, left, right);
                    return Ok(name, 2);
                case "snap":
                case "extend":
                case "trim":
                    MoveEnd(WallOf(doc, kept), End(op), Point(op));
                    return Ok(name, 1);
                case "attach_top":
                    Attach(doc, WallOf(doc, kept), op, AttachmentLocation.Top);
                    return Ok(name, 1);
                case "attach_base":
                    Attach(doc, WallOf(doc, kept), op, AttachmentLocation.Base);
                    return Ok(name, 1);
                case "rehost":
                    Rehost(doc, kept, op);
                    return Ok(name, 1);
                default:
                    throw new InvalidOperationException("Unknown joins operation " + name);
            }
        }

        private static JObject Ok(string name, int count) => new JObject { ["op"] = name, ["ok"] = true, ["count"] = count };

        private static Wall WallOf(Document doc, List<ElementId> ids)
        {
            if (ids.Count == 0) throw new InvalidOperationException("[FMC-JOINS] The wall id is missing.");
            return doc.GetElement(ids[0]) as Wall ?? throw new InvalidOperationException("[FMC-JOINS] Element " + ids[0].Value + " is not a wall.");
        }

        private static int End(JObject op)
        {
            int end = op.Value<int?>("end") ?? 0;
            return end == 1 ? 1 : 0;
        }

        private static XYZ Point(JObject op)
        {
            JObject xyz = op["xyz"] as JObject ?? throw new InvalidOperationException("[FMC-JOINS] The endpoint is missing.");
            return new XYZ(xyz.Value<double>("x") / Mm, xyz.Value<double>("y") / Mm, xyz.Value<double>("z") / Mm);
        }

        private static void MoveEnd(Wall wall, int end, XYZ target)
        {
            if (wall.Location is not LocationCurve location || location.Curve is not Line line)
                throw new InvalidOperationException("[FMC-JOINS] The wall is not a straight line.");
            XYZ start = end == 0 ? target : line.GetEndPoint(0);
            XYZ finish = end == 1 ? target : line.GetEndPoint(1);
            if (start.DistanceTo(finish) < 1e-4) throw new InvalidOperationException("[FMC-JOINS] The wall would have no length.");
            location.Curve = Line.CreateBound(start, finish);
        }

        private static void Attach(Document doc, Wall wall, JObject op, AttachmentLocation location)
        {
            string host = (op.Value<string>("host") ?? "").Trim();
            if (!long.TryParse(host, out long value)) throw new InvalidOperationException("[FMC-JOINS] The attach target is missing.");
            var id = new ElementId(value);
            if (doc.GetElement(id) == null) throw new InvalidOperationException("[FMC-JOINS] The attach target is not in this document.");
            if (!Wall.IsValidTargetAttachment(doc, id)) throw new InvalidOperationException("[FMC-JOINS] That element cannot take this wall attachment.");
            wall.AddAttachment(id, location);
        }

        private static void Rehost(Document doc, List<ElementId> ids, JObject op)
        {
            if (ids.Count == 0) throw new InvalidOperationException("[FMC-JOINS] The family id is missing.");
            Element element = doc.GetElement(ids[0]) ?? throw new InvalidOperationException("[FMC-JOINS] The family is not in this document.");
            if (op["move_mm"] is JObject move)
            {
                var delta = new XYZ(move.Value<double>("x") / Mm, move.Value<double>("y") / Mm, move.Value<double>("z") / Mm);
                if (delta.GetLength() > 1e-9) ElementTransformUtils.MoveElement(doc, element.Id, delta);
                return;
            }
            if (element is not FamilyInstance instance) throw new InvalidOperationException("[FMC-JOINS] Re-host applies to a family instance.");
            Parameter parameter = instance.get_Parameter(BuiltInParameter.INSTANCE_FREE_HOST_OFFSET_PARAM)
                ?? instance.get_Parameter(BuiltInParameter.INSTANCE_ELEVATION_PARAM);
            if (parameter == null || parameter.IsReadOnly || parameter.StorageType != StorageType.Double)
                throw new InvalidOperationException("[FMC-JOINS] The family offset is not writable.");
            parameter.Set((op.Value<double?>("offset_mm") ?? 0) / Mm);
        }

        private static List<ElementId> Ids(JObject op)
        {
            var list = new List<ElementId>();
            void Add(string text)
            {
                if (long.TryParse(text, out long value) && value > 0) list.Add(new ElementId(value));
            }
            if (op["ids"] is JArray array)
                foreach (JToken token in array) Add(token.ToString());
            return list.GroupBy(id => id.Value).Select(group => group.First()).ToList();
        }
    }
}
