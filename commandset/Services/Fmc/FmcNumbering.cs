using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Read for fmc_numbering. No transaction, no checkout, no save.
    /// Doors and windows: Mark. Rooms: Room Number. Sheets: Sheet Number. Views: the Detail Number of each viewport.
    /// Grids: Grid Name. The rule and the plan live on the server; this read only reports the current numbers and positions (mm).
    /// </summary>
    public class FmcNumberingHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft numbering";

        private const double Mm = 304.8;

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_numbering needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Result = Read(doc, Wants(Parameters));
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        /// <summary>Only the categories asked for are read. No categories means all of them.</summary>
        internal static HashSet<string> Wants(JObject parameters)
        {
            var all = new[] { "Doors", "Windows", "Rooms", "Sheets", "Views", "Grids" };
            if (parameters?["categories"] is JArray list && list.Count > 0)
                return new HashSet<string>(all.Where(name => list.Any(item => string.Equals(item?.ToString()?.Trim(), name, StringComparison.OrdinalIgnoreCase))));
            return new HashSet<string>(all);
        }

        internal static JObject Read(Document doc, HashSet<string> wants)
        {
            var result = new JObject
            {
                ["read_only"] = true,
                ["title"] = doc.Title ?? "",
                ["path"] = doc.PathName ?? "",
                ["is_central"] = FmcPhaseIds.IsCentral(doc),
            };
            if (wants.Contains("Doors")) result["doors"] = Instances(doc, BuiltInCategory.OST_Doors);
            if (wants.Contains("Windows")) result["windows"] = Instances(doc, BuiltInCategory.OST_Windows);
            if (wants.Contains("Rooms")) result["rooms"] = Rooms(doc);
            if (wants.Contains("Sheets")) result["sheets"] = Sheets(doc);
            if (wants.Contains("Views"))
            {
                Views(doc, out JArray onSheet, out JArray offSheet);
                result["views"] = onSheet;
                result["views_off_sheet"] = offSheet;
            }
            if (wants.Contains("Grids")) result["grids"] = Grids(doc);
            return result;
        }

        static JObject LevelOf(Document doc, Element element)
        {
            var row = new JObject();
            Level level = element.LevelId != ElementId.InvalidElementId ? doc.GetElement(element.LevelId) as Level : null;
            if (level != null)
            {
                row["level"] = level.Name;
                row["level_elev"] = Math.Round(level.Elevation * Mm, 1);
            }
            return row;
        }

        static JArray Instances(Document doc, BuiltInCategory category)
        {
            var rows = new JArray();
            foreach (Element element in new FilteredElementCollector(doc).OfCategory(category).WhereElementIsNotElementType())
            {
                var row = LevelOf(doc, element);
                row["id"] = element.Id.Value.ToString();
                row["current"] = element.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString() ?? "";
                if (element.Location is LocationPoint point)
                {
                    row["x"] = Math.Round(point.Point.X * Mm, 1);
                    row["y"] = Math.Round(point.Point.Y * Mm, 1);
                }
                rows.Add(row);
            }
            return rows;
        }

        static JArray Rooms(Document doc)
        {
            var rows = new JArray();
            foreach (Room room in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType().OfType<Room>())
            {
                var row = LevelOf(doc, room);
                row["id"] = room.Id.Value.ToString();
                row["current"] = room.Number ?? "";
                row["name"] = room.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? "";
                row["placed"] = room.Location != null && room.Area > 0;
                if (room.Location is LocationPoint point)
                {
                    row["x"] = Math.Round(point.Point.X * Mm, 1);
                    row["y"] = Math.Round(point.Point.Y * Mm, 1);
                }
                rows.Add(row);
            }
            return rows;
        }
        static JArray Sheets(Document doc)
        {
            var rows = new JArray();
            foreach (ViewSheet sheet in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
                rows.Add(new JObject { ["id"] = sheet.Id.Value.ToString(), ["current"] = sheet.SheetNumber ?? "", ["name"] = sheet.Name ?? "" });
            return rows;
        }

        static void Views(Document doc, out JArray onSheet, out JArray offSheet)
        {
            onSheet = new JArray();
            offSheet = new JArray();
            var placed = new HashSet<long>();
            foreach (ViewSheet sheet in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
            {
                foreach (ElementId id in sheet.GetAllViewports())
                {
                    if (doc.GetElement(id) is not Viewport viewport) continue;
                    placed.Add(viewport.ViewId.Value);
                    XYZ center = viewport.GetBoxCenter();
                    onSheet.Add(new JObject
                    {
                        ["id"] = viewport.Id.Value.ToString(),
                        ["current"] = viewport.get_Parameter(BuiltInParameter.VIEWPORT_DETAIL_NUMBER)?.AsString() ?? "",
                        ["sheet_id"] = sheet.Id.Value.ToString(),
                        ["sheet_number"] = sheet.SheetNumber ?? "",
                        ["view_name"] = (doc.GetElement(viewport.ViewId) as View)?.Name ?? "",
                        ["x"] = Math.Round(center.X * Mm, 1),
                        ["y"] = Math.Round(center.Y * Mm, 1),
                    });
                }
            }
            foreach (View view in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>())
            {
                if (view.IsTemplate || view is ViewSheet || !view.CanBePrinted || placed.Contains(view.Id.Value)) continue;
                offSheet.Add(new JObject { ["id"] = view.Id.Value.ToString(), ["current"] = "", ["view_name"] = view.Name ?? "" });
            }
        }

        static JArray Grids(Document doc)
        {
            var rows = new JArray();
            foreach (Grid grid in new FilteredElementCollector(doc).OfClass(typeof(Grid)).Cast<Grid>())
            {
                string direction = "other";
                double x = 0, y = 0;
                if (!grid.IsCurved && grid.Curve is Line line)
                {
                    XYZ d = line.Direction;
                    XYZ mid = line.Evaluate(0.5, true);
                    x = mid.X * Mm;
                    y = mid.Y * Mm;
                    const double tolerance = 0.01745; // one degree
                    if (Math.Abs(d.X) < tolerance) direction = "vertical";
                    else if (Math.Abs(d.Y) < tolerance) direction = "horizontal";
                }
                rows.Add(new JObject
                {
                    ["id"] = grid.Id.Value.ToString(),
                    ["current"] = grid.Name ?? "",
                    ["name"] = grid.Name ?? "",
                    ["direction"] = direction,
                    ["x"] = Math.Round(x, 1),
                    ["y"] = Math.Round(y, 1),
                });
            }
            return rows;
        }
    }
    /// <summary>
    /// One transaction, all or nothing. Each op carries the old value the plan was made from; a changed value (stale plan) rolls everything back.
    /// Rooms, sheets, viewports and grids must stay unique at every step, so every changing item first takes a temporary name, then its final one.
    /// Never saves or synchronises.
    /// </summary>
    public class FmcNumberingApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft numbering apply";

        private sealed class Op
        {
            public string Category = "";
            public string Id = "";
            public string Old = "";
            public string New = "";
            public Element Element;
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_numbering_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Refuse(doc);
                    List<Op> ops = Parse(doc, Parameters["ops"] as JArray ?? new JArray());
                    if (ops.Count == 0) throw new InvalidOperationException("[FMC-NUM-NOTHING] No renames were sent.");
                    CheckDuplicates(ops);
                    using (var transaction = new Transaction(doc, "Formcraft numbering"))
                    {
                        transaction.Start();
                        try
                        {
                            foreach (Op op in ops.Where(NeedsTemp)) Set(op, Temp(op));
                            foreach (Op op in ops) Set(op, op.New);
                            transaction.Commit();
                        }
                        catch
                        {
                            if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                            throw;
                        }
                    }
                    var results = new JArray();
                    foreach (Op op in ops)
                        results.Add(new JObject { ["category"] = op.Category, ["id"] = op.Id, ["old"] = op.Old, ["new"] = op.New, ["written"] = true, ["result"] = "renamed" });
                    Result = new JObject
                    {
                        ["ok"] = true,
                        ["renamed"] = ops.Count,
                        ["results"] = results,
                        ["saved"] = false,
                        ["synced"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_numbering.");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by fmc_numbering.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }

        private static List<Op> Parse(Document doc, JArray rows)
        {
            var ops = new List<Op>();
            foreach (JObject row in rows.OfType<JObject>())
            {
                var op = new Op
                {
                    Category = row.Value<string>("category") ?? "",
                    Id = row.Value<string>("id") ?? "",
                    Old = row.Value<string>("old") ?? "",
                    New = row.Value<string>("new") ?? "",
                };
                if (!long.TryParse(op.Id, out long id)) throw new InvalidOperationException($"[FMC-NUM-BAD-ID] {op.Category} id {op.Id} is not a number.");
                op.Element = doc.GetElement(new ElementId(id));
                if (op.Element == null) throw new InvalidOperationException($"[FMC-NUM-STALE] {op.Category} {op.Id} is not in the model any more. Nothing was written.");
                if (op.New.Length == 0) throw new InvalidOperationException($"[FMC-NUM-BAD-RULE] {op.Category} {op.Id} has an empty new number.");
                string now = Current(op);
                if (!string.Equals(now, op.Old, StringComparison.Ordinal))
                    throw new InvalidOperationException($"[FMC-NUM-STALE] {op.Category} {op.Id} is now \"{now}\", the plan was made from \"{op.Old}\". Run the dry run again. Nothing was written.");
                ops.Add(op);
            }
            return ops;
        }

        /// <summary>The server already refused duplicates; this is the add-in's own check of what it was sent.</summary>
        private static void CheckDuplicates(List<Op> ops)
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Op op in ops)
            {
                string scope = op.Category == "Views" && op.Element is Viewport vp ? vp.SheetId.Value.ToString() : "";
                if (!seen.Add(op.Category + "|" + scope + "|" + op.New))
                    throw new InvalidOperationException($"[FMC-NUM-DUPLICATE] {op.Category} \"{op.New}\" is sent twice. Nothing was written.");
            }
        }

        private static bool NeedsTemp(Op op) => op.Category == "Rooms" || op.Category == "Sheets" || op.Category == "Views" || op.Category == "Grids";

        private static string Temp(Op op) => "~FMC" + op.Id;

        private static Parameter ParameterOf(Op op)
        {
            switch (op.Category)
            {
                case "Doors":
                case "Windows":
                    return op.Element.get_Parameter(BuiltInParameter.ALL_MODEL_MARK);
                case "Views":
                    return op.Element.get_Parameter(BuiltInParameter.VIEWPORT_DETAIL_NUMBER);
                default:
                    return null;
            }
        }

        private static string Current(Op op)
        {
            switch (op.Category)
            {
                case "Doors":
                case "Windows":
                case "Views":
                    return ParameterOf(op)?.AsString() ?? "";
                case "Rooms": return (op.Element as Room)?.Number ?? "";
                case "Sheets": return (op.Element as ViewSheet)?.SheetNumber ?? "";
                case "Grids": return (op.Element as Grid)?.Name ?? "";
                default: throw new InvalidOperationException($"[FMC-NUM-BAD-RULE] Unknown category {op.Category}.");
            }
        }

        private static void Set(Op op, string value)
        {
            switch (op.Category)
            {
                case "Doors":
                case "Windows":
                case "Views":
                    {
                        Parameter p = ParameterOf(op);
                        if (p == null || p.IsReadOnly || !p.Set(value))
                            throw new InvalidOperationException($"[FMC-NUM-READONLY] {op.Category} {op.Id}: the number could not be set to \"{value}\". Nothing was written.");
                        break;
                    }
                case "Rooms": ((Room)op.Element).Number = value; break;
                case "Sheets": ((ViewSheet)op.Element).SheetNumber = value; break;
                case "Grids": ((Grid)op.Element).Name = value; break;
            }
        }
    }
}