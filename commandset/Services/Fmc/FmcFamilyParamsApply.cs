using System.IO;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Adds a parameter, a label, or a project binding on the family loaded in the project.
    /// EditFamily, then LoadFamily with overwrite, then Close(false). The family file is never saved.
    /// </summary>
    public class FmcFamilyParamsApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft family parameters apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            Document fam = null;
            bool opened = false;
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_family_params_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Refuse(doc);
                    string action = (Parameters.Value<string>("action") ?? "").Trim();
                    if (action == "bind")
                    {
                        Result = Bind(app, doc);
                        Result["kit_saved"] = false;
                        Result["saved"] = false;
                        Result["synced"] = false;
                        return;
                    }
                    string familyName = (Parameters.Value<string>("family") ?? "").Trim();
                    Family family = FmcFamilyParamsHandler.Find(doc, familyName);
                    if (family.IsInPlace) throw new InvalidOperationException("[FMC-FAMILY-INPLACE] An in-place family is not edited by fmc_family_params.");
                    try { fam = doc.EditFamily(family); opened = fam != null; }
                    catch (Exception)
                    {
                        fam = null;
                        throw new InvalidOperationException("[FMC-FAMILY-OPEN] " + family.Name + " is already open for edit. Close it without saving the kit file, then run the call again.");
                    }
                    if (fam == null) throw new InvalidOperationException("[FMC-FAMILY-OPEN] Revit did not open " + family.Name + ".");
                    string name = (Parameters.Value<string>("name") ?? "").Trim();
                    using (var familyTransaction = new Transaction(fam, "Formcraft family parameter"))
                    {
                        var options = familyTransaction.GetFailureHandlingOptions();
                        options.SetFailuresPreprocessor(new Quiet());
                        options.SetClearAfterRollback(true);
                        familyTransaction.SetFailureHandlingOptions(options);
                        familyTransaction.Start();
                        try
                        {
                            if (action == "add") Add(app, fam, name);
                            else if (action == "label") Label(fam, name);
                            else throw new InvalidOperationException("[FMC-PARAM-ACTION] fmc_family_params_apply knows add, label and bind.");
                            familyTransaction.Commit();
                        }
                        catch
                        {
                            if (familyTransaction.HasStarted() && !familyTransaction.HasEnded()) familyTransaction.RollBack();
                            throw;
                        }
                    }
                    Family loaded = null;
                    // Document.LoadFamily(Document, IFamilyLoadOptions) runs its own transaction in the project and must not be called inside one.
                    loaded = fam.LoadFamily(doc, new Overwrite());
                    if (loaded == null)
                        throw new InvalidOperationException("[FMC-FAMILY-LOAD] LoadFamily did not return the family. The project was not saved. The family file was not saved.");
                    Result = new JObject
                    {
                        ["ok"] = true,
                        ["action"] = action,
                        ["family"] = loaded.Name,
                        ["family_id"] = loaded.Id.Value.ToString(),
                        ["parameter"] = name,
                        ["kit_saved"] = false,
                        ["family_file_saved"] = false,
                        ["saved"] = false,
                        ["synced"] = false,
                        ["resolved_document"] = FmcTarget.Resolved(doc),
                    };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally
            {
                if (opened && fam != null)
                {
                    // Close(false) discards the family document. The kit .rfa is not saved, even when PathName still points at it.
                    try { fam.Close(false); } catch (Exception) { /* already closed */ }
                }
                _done.Set();
            }
        }

        private void Add(UIApplication app, Document fam, string name)
        {
            FamilyManager manager = fam.FamilyManager;
            if (manager.get_Parameter(name) != null) return;
            bool instance = !string.Equals(Parameters.Value<string>("binding"), "type", StringComparison.OrdinalIgnoreCase);
            ForgeTypeId group = Group(Parameters.Value<string>("group"));
            bool shared = Parameters.Value<bool?>("shared") != false;
            if (!shared)
            {
                manager.AddParameter(name, group, Spec(Parameters.Value<string>("type") ?? "text"), instance);
                return;
            }
            using (FmcSharedParams.Use(app.Application, KitFilePath()))
            {
                ExternalDefinition definition = OpenDefinition(app);
                ForgeTypeId asked = Spec(Parameters.Value<string>("type") ?? "");
                if ((Parameters.Value<string>("type") ?? "").Length > 0 && !SameType(definition.GetDataType(), asked))
                    throw new InvalidOperationException("[FMC-PARAM-TYPE] The kit definition type does not match " + Parameters.Value<string>("type") + ". The kit file was not changed.");
                manager.AddParameter(definition, group, instance);
            }
        }

        private void Label(Document fam, string name)
        {
            FamilyParameter parameter = fam.FamilyManager.get_Parameter(name);
            if (parameter == null) throw new InvalidOperationException("[FMC-PARAM-MISSING] \"" + name + "\" is not a parameter of this family. Add it first.");
            View view = FamilyView(fam);
            if (view == null) throw new InvalidOperationException("[FMC-PARAM-VIEW] The family has no view to place a label in.");
            JArray origin = Parameters["origin_mm"] as JArray;
            double x = origin != null && origin.Count > 0 ? origin[0].Value<double>() / 304.8 : 10 / 304.8;
            double y = origin != null && origin.Count > 1 ? origin[1].Value<double>() / 304.8 : 10 / 304.8;
            var list = new List<FamilyParameter> { parameter };
            // The Revit 2025 API has no method that creates a family label (FamilyItemFactory has no NewLabel). Nothing is placed and no text note is substituted.
            throw new InvalidOperationException("[FMC-NO-API-LABEL] Revit 2025 has no API to create a label in a family. Place the label for \"" + name + "\" by hand in the kit title block; the parameter itself can be added with action add.");
        }

        private JObject Bind(UIApplication app, Document doc)
        {
            string rawCategories = "";
            var categories = new JArray();
            CategorySet set = app.Application.Create.NewCategorySet();
            foreach (string name in (Parameters["categories"] as JArray ?? new JArray()).Select(token => token.ToString().Trim()).Where(s => s.Length > 0))
            {
                rawCategories = name;
                if (!Enum.TryParse(name, true, out BuiltInCategory builtIn))
                {
                    categories.Add(new JObject { ["category"] = name, ["code"] = "FMC-PARAM-CATEGORY", ["message"] = name + " is not a built-in category." });
                    continue;
                }
                Category category = Category.GetCategory(doc, builtIn);
                if (category == null || !category.AllowsBoundParameters)
                {
                    categories.Add(new JObject { ["category"] = name, ["code"] = "FMC-PARAM-CATEGORY", ["message"] = name + " cannot take a project parameter." });
                    continue;
                }
                set.Insert(category);
                categories.Add(new JObject { ["category"] = name, ["bound"] = true });
            }
            if (set.Size == 0) throw new InvalidOperationException("[FMC-PARAM-CATEGORY] No category accepted the binding. Last name: " + rawCategories);
            bool instance = !string.Equals(Parameters.Value<string>("binding"), "type", StringComparison.OrdinalIgnoreCase);
            Binding binding = instance ? app.Application.Create.NewInstanceBinding(set) : app.Application.Create.NewTypeBinding(set);
            ForgeTypeId group = Group(Parameters.Value<string>("group"));
            string boundName;
            string boundGuid;
            using (FmcSharedParams.Use(app.Application, KitFilePath()))
            {
                ExternalDefinition definition = OpenDefinition(app);
                boundName = definition.Name;
                boundGuid = definition.GUID.ToString();
                using (var transaction = new Transaction(doc, "Formcraft bind parameter"))
                {
                    var options = transaction.GetFailureHandlingOptions();
                    options.SetFailuresPreprocessor(new Quiet());
                    options.SetClearAfterRollback(true);
                    transaction.SetFailureHandlingOptions(options);
                    transaction.Start();
                    try
                    {
                        BindingMap map = doc.ParameterBindings;
                        bool ok = map.Contains(definition) ? map.ReInsert(definition, binding, group) : map.Insert(definition, binding, group);
                        if (!ok) throw new InvalidOperationException("[FMC-PARAM-BIND] Revit did not bind " + definition.Name + ".");
                        transaction.Commit();
                    }
                    catch
                    {
                        if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                        throw;
                    }
                }
            }
            return new JObject
            {
                ["ok"] = true,
                ["action"] = "bind",
                ["parameter"] = boundName,
                ["guid"] = boundGuid,
                ["categories"] = categories,
                ["resolved_document"] = FmcTarget.Resolved(doc),
            };
        }

        private string KitFilePath()
        {
            string file = (Parameters.Value<string>("shared_parameter_file") ?? Parameters.Value<string>("kit_file") ?? "").Trim();
            if (file.Length == 0 || !File.Exists(file))
                throw new InvalidOperationException("[FMC-PARAM-FILE] The kit shared parameter file is not readable. No definition was created.");
            return file;
        }

        private ExternalDefinition OpenDefinition(UIApplication app)
        {
            string name = (Parameters.Value<string>("name") ?? "").Trim();
            string guid = (Parameters.Value<string>("guid") ?? "").Trim();
            DefinitionFile definitions = app.Application.OpenSharedParameterFile();
            if (definitions == null) throw new InvalidOperationException("[FMC-PARAM-FILE] Revit could not open the kit shared parameter file. No definition was created.");
            ExternalDefinition found = Find(definitions, name, guid);
            if (found == null)
                throw new InvalidOperationException("[FMC-PARAM-NOT-IN-KIT] \"" + name + "\" is not in the kit shared parameter file with GUID " + guid + ". Kit change: add it. No definition was created.");
            return found;
        }

        private static ExternalDefinition Find(DefinitionFile file, string name, string guid)
        {
            foreach (DefinitionGroup group in file.Groups)
            {
                if (group.Definitions.get_Item(name) is ExternalDefinition definition)
                {
                    if (guid.Length == 0 || string.Equals(definition.GUID.ToString(), guid, StringComparison.OrdinalIgnoreCase)) return definition;
                }
            }
            return null;
        }

        private static View FamilyView(Document fam)
        {
            var views = new FilteredElementCollector(fam).OfClass(typeof(View)).Cast<View>()
                .Where(v => !v.IsTemplate && v.ViewType != ViewType.ProjectBrowser && v.ViewType != ViewType.SystemBrowser && v.ViewType != ViewType.ThreeD)
                .ToList();
            return views.FirstOrDefault(v => v.ViewType == ViewType.DrawingSheet)
                ?? views.FirstOrDefault(v => v.Name.IndexOf("sheet", StringComparison.OrdinalIgnoreCase) >= 0)
                ?? views.FirstOrDefault(v => v is ViewDrafting)
                ?? views.FirstOrDefault();
        }

        internal static ForgeTypeId Group(string name)
        {
            string key = (name ?? "").ToLowerInvariant().Replace(" ", "").Replace("_", "");
            return key switch
            {
                "text" => GroupTypeId.Text,
                "materials" or "materialsandfinishes" => GroupTypeId.Materials,
                "identity" or "identitydata" => GroupTypeId.IdentityData,
                "constraints" => GroupTypeId.Constraints,
                "data" => GroupTypeId.Data,
                "graphics" => GroupTypeId.Graphics,
                "general" => GroupTypeId.General,
                _ => GroupTypeId.IdentityData,
            };
        }

        internal static ForgeTypeId Spec(string name)
        {
            switch ((name ?? "").ToLowerInvariant().Replace(" ", "").Replace("_", ""))
            {
                case "text": return SpecTypeId.String.Text;
                case "number": return SpecTypeId.Number;
                case "integer": return SpecTypeId.Int.Integer;
                case "yesno": return SpecTypeId.Boolean.YesNo;
                case "material": return SpecTypeId.Reference.Material;
                case "angle": return SpecTypeId.Angle;
                case "area": return SpecTypeId.Area;
                case "volume": return SpecTypeId.Volume;
                case "length": return SpecTypeId.Length;
                case "": return SpecTypeId.String.Text;
                default: throw new InvalidOperationException("[FMC-PARAM-TYPE] type is text, number, integer, yesno, material, angle, area, volume or length.");
            }
        }

        private static bool SameType(ForgeTypeId definition, ForgeTypeId asked)
        {
            if (definition == null || asked == null) return false;
            if (definition.Equals(asked)) return true;
            try
            {
                if (asked.Equals(SpecTypeId.String.Text) && definition.Equals(SpecTypeId.String.MultilineText)) return true;
            }
            catch (Exception) { /* MultilineText is not on this build */ }
            return false;
        }

        private static void Refuse(Document doc)
        {
            if (doc.IsFamilyDocument)
                throw new InvalidOperationException("[FMC-FAMILY-PROJECT] Work on the project's loaded family. This document is a family file.");
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (System.Text.RegularExpressions.Regex.IsMatch(blob, "hebert hostels", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_family_params.");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by fmc_family_params.");
            string norm = (doc.PathName ?? "").Replace('/', '\\');
            bool staging = norm.IndexOf("\\_Staging\\", StringComparison.OrdinalIgnoreCase) >= 0 || norm.IndexOf("\\_ChainTests\\", StringComparison.OrdinalIgnoreCase) >= 0;
            if (!staging && norm.IndexOf("\\04_Families\\", StringComparison.OrdinalIgnoreCase) >= 0)
                throw new InvalidOperationException("A kit family file is not edited. Open the project and name the loaded family.");
        }

        private sealed class Quiet : IFailuresPreprocessor
        {
            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                foreach (FailureMessageAccessor message in accessor.GetFailureMessages())
                    if (message.GetSeverity() == FailureSeverity.Warning) accessor.DeleteWarning(message);
                return FailureProcessingResult.Continue;
            }
        }

        private sealed class Overwrite : IFamilyLoadOptions
        {
            public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues)
            {
                overwriteParameterValues = true;
                return true;
            }

            public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues)
            {
                source = FamilySource.Family;
                overwriteParameterValues = true;
                return true;
            }
        }
    }
}
