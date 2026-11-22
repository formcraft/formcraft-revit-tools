using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Lists parameters on a family loaded in the project. EditFamily is closed without saving.
    /// No transaction. The kit family file is not written.
    /// </summary>
    public class FmcFamilyParamsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft family parameters";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_family_params needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    if (doc.IsFamilyDocument)
                        throw new InvalidOperationException("[FMC-FAMILY-PROJECT] Work on the project's loaded family. This document is a family file, and a kit original is not edited.");
                    string familyName = (Parameters.Value<string>("family") ?? "").Trim();
                    var titleblocks = Titleblocks(doc);
                    if (familyName.Length == 0)
                    {
                        Result = new JObject
                        {
                            ["read_only"] = true,
                            ["resolved_document"] = FmcTarget.Resolved(doc),
                            ["is_central"] = FmcPhaseIds.IsCentral(doc),
                            ["titleblocks"] = titleblocks,
                            ["parameters"] = new JArray(),
                            ["labels"] = new JArray(),
                            ["kit_saved"] = false,
                        };
                        return;
                    }
                    Family family = Find(doc, familyName);
                    if (family.IsInPlace) throw new InvalidOperationException("[FMC-FAMILY-INPLACE] An in-place family is not edited by fmc_family_params.");
                    Document fam = null;
                    bool opened = false;
                    try
                    {
                        try { fam = doc.EditFamily(family); opened = fam != null; }
                        catch (Exception)
                        {
                            fam = OpenFamily(app, family.Name);
                        }
                        if (fam == null) throw new InvalidOperationException("[FMC-FAMILY-NOT-LOADED] Revit did not open " + family.Name + ".");
                        var texts = new List<string>();
                        foreach (TextElement text in new FilteredElementCollector(fam).OfClass(typeof(TextElement)).Cast<TextElement>())
                            if (!string.IsNullOrWhiteSpace(text.Text)) texts.Add(text.Text);
                        var parameters = new JArray();
                        foreach (FamilyParameter parameter in fam.FamilyManager.Parameters)
                        {
                            string typeId = "";
                            string group = "";
                            try { typeId = parameter.Definition.GetDataType().TypeId ?? ""; } catch (Exception) { /* type not published */ }
                            try { group = LabelUtils.GetLabelForGroup(parameter.Definition.GetGroupTypeId()); } catch (Exception) { /* group not published */ }
                            bool labelled = texts.Any(text => string.Equals(text, parameter.Definition.Name, StringComparison.OrdinalIgnoreCase));
                            parameters.Add(new JObject
                            {
                                ["name"] = parameter.Definition.Name,
                                ["instance"] = parameter.IsInstance,
                                ["shared"] = parameter.IsShared,
                                ["guid"] = parameter.IsShared ? parameter.GUID.ToString() : "",
                                ["type_id"] = typeId,
                                ["group"] = group,
                                ["has_label"] = labelled,
                            });
                        }
                        Result = new JObject
                        {
                            ["read_only"] = true,
                            ["resolved_document"] = FmcTarget.Resolved(doc),
                            ["is_central"] = FmcPhaseIds.IsCentral(doc),
                            ["family"] = family.Name,
                            ["family_path"] = fam.PathName ?? "",
                            ["titleblocks"] = titleblocks,
                            ["parameters"] = parameters,
                            ["labels"] = new JArray(texts.Take(50)),
                            ["kit_saved"] = false,
                            ["label_note"] = "has_label is true when the visible label text equals the parameter name. Revit does not publish the bound parameter.",
                        };
                    }
                    finally
                    {
                        if (opened && fam != null) fam.Close(false);
                    }
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        internal static Family Find(Document doc, string name)
        {
            var hits = new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>()
                .Where(f => string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase)).ToList();
            if (hits.Count == 0)
                throw new InvalidOperationException("[FMC-FAMILY-NOT-LOADED] \"" + name + "\" is not loaded in this project. Load it into the project first. The kit file is not opened.");
            if (hits.Count > 1)
                throw new InvalidOperationException("[FMC-FAMILY-AMBIGUOUS] \"" + name + "\" matches " + hits.Count + " loaded families.");
            return hits[0];
        }

        private static JArray Titleblocks(Document doc)
        {
            var rows = new JArray();
            foreach (Family family in new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>())
            {
                if (family.FamilyCategory == null || family.FamilyCategory.Id.Value != (long)BuiltInCategory.OST_TitleBlocks) continue;
                rows.Add(new JObject { ["name"] = family.Name, ["id"] = family.Id.Value.ToString() });
            }
            return rows;
        }

        private static Document OpenFamily(UIApplication app, string name)
        {
            foreach (Document open in app.Application.Documents)
                if (open.IsFamilyDocument && string.Equals(open.Title, name, StringComparison.OrdinalIgnoreCase)) return open;
            return null;
        }
    }
}
