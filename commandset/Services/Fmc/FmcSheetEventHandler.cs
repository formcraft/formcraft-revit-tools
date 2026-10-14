using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Sheets (U19) on the Revit main thread. facts reads every sheet (number, name, views placed, the asked-for fields)
    /// and the loaded title blocks; create makes sheets from the register with a title block; rename gives sheets the
    /// register's names. create and rename only plan when dry_run is true; the server sends real runs through the lock.
    /// </summary>
    public class FmcSheetEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string Action { get; set; } = "";
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                using var target = FmcTarget.Resolve(app, Parameters, mayOpen: Action == "facts");
                Document doc = target.Doc;
                if (doc.IsFamilyDocument) throw new InvalidOperationException("Sheets live in a project model.");
                switch (Action)
                {
                    case "facts": Result = Facts(doc); break;
                    case "create": Result = Create(doc); break;
                    case "rename": Result = Rename(doc); break;
                    default: Error = $"Unknown FMC sheet action '{Action}'"; break;
                }
            }
            catch (Exception ex)
            {
                Error = ex.Message;
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public string GetName() => "FMC sheets";

        private static List<FamilySymbol> TitleBlocks(Document doc) => new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsElementType().Cast<FamilySymbol>().ToList();

        private static string Label(FamilySymbol s) => s.FamilyName + " : " + s.Name;

        private JObject Facts(Document doc)
        {
            var fields = (Parameters["fields"] as JArray)?.Select(x => x.ToString()).ToList() ?? new List<string>();
            var sheets = new JArray();
            foreach (ViewSheet s in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
            {
                if (s.IsPlaceholder) continue;
                var values = new JObject();
                foreach (string f in fields)
                {
                    Parameter p = s.LookupParameter(f);
                    if (p == null) continue;
                    values[f] = p.StorageType == StorageType.String ? p.AsString() ?? "" : p.AsValueString() ?? "";
                }
                sheets.Add(new JObject { ["id"] = s.Id.Value, ["number"] = s.SheetNumber, ["name"] = s.Name, ["views"] = s.GetAllPlacedViews().Count, ["fields"] = values });
            }
            return new JObject { ["model"] = doc.Title, ["sheets"] = sheets, ["title_blocks"] = new JArray(TitleBlocks(doc).Select(Label)) };
        }

        private JObject Create(Document doc)
        {
            bool dry = Parameters.Value<bool?>("dry_run") != false;
            string wanted = Parameters.Value<string>("title_block") ?? "";
            var blocks = TitleBlocks(doc);
            FamilySymbol block = blocks.FirstOrDefault(b => Label(b) == wanted || b.Name == wanted) ?? blocks.FirstOrDefault();
            var existing = new HashSet<string>(new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>().Select(s => s.SheetNumber));
            var made = new JArray();
            Transaction t = dry ? null : new Transaction(doc, "Formcraft: sheets from the register");
            t?.Start();
            try
            {
                foreach (JObject s in (Parameters["sheets"] as JArray ?? new JArray()).OfType<JObject>())
                {
                    string number = s.Value<string>("number"), name = s.Value<string>("name") ?? "";
                    if (existing.Contains(number)) { made.Add(new JObject { ["number"] = number, ["name"] = name, ["result"] = "exists" }); continue; }
                    if (!dry)
                    {
                        if (block != null && !block.IsActive) block.Activate();
                        ViewSheet v = ViewSheet.Create(doc, block?.Id ?? ElementId.InvalidElementId);
                        v.SheetNumber = number;
                        if (name.Length > 0) v.Name = name;
                    }
                    made.Add(new JObject { ["number"] = number, ["name"] = name, ["result"] = dry ? "would create" : "created" });
                }
                t?.Commit();
            }
            finally
            {
                t?.Dispose();
            }
            return new JObject { ["sheets"] = made, ["title_block"] = block != null ? Label(block) : "none (sheets without a title block)" };
        }

        private JObject Rename(Document doc)
        {
            bool dry = Parameters.Value<bool?>("dry_run") != false;
            var done = new JArray();
            Transaction t = dry ? null : new Transaction(doc, "Formcraft: sheet names from the register");
            t?.Start();
            try
            {
                foreach (JObject s in (Parameters["sheets"] as JArray ?? new JArray()).OfType<JObject>())
                {
                    if (!(doc.GetElement(new ElementId(s.Value<long>("id"))) is ViewSheet v)) continue;
                    string from = v.Name, to = s.Value<string>("name") ?? "";
                    if (!dry && to.Length > 0) v.Name = to;
                    done.Add(new JObject { ["number"] = v.SheetNumber, ["from"] = from, ["name"] = to, ["result"] = dry ? "would rename" : "renamed" });
                }
                t?.Commit();
            }
            finally
            {
                t?.Dispose();
            }
            return new JObject { ["sheets"] = done };
        }
    }
}
