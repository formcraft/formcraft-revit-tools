using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// fmc_visibility: WHY an element is or is not visible in a view. Read only: no transaction, nothing is set, hidden,
    /// unhidden, isolated or overridden. Every check either passes, finds a reason, is not applicable (and says why) or is
    /// "unknown" with the reason it could not be decided; a check is never skipped silently.
    /// Reason status: "hides" (this alone hides it), "likely" (best effort, probably hides it), "unknown" (could not be
    /// decided), "info" (context that changes the fix, e.g. a view template). visible is "no" when any reason hides,
    /// "unknown" when none hides but one is likely or unknown, else "yes". Fixes are text only.
    /// </summary>
    public static class FmcVisibility
    {
        // The order the reasons are reported in (the server sorts by the same list).
        public static readonly string[] Order =
        {
            "element_hidden", "temporary_hide", "category", "subcategory", "filter", "view_template", "workset", "design_option",
            "phase", "crop_region", "view_range", "section_box", "far_clip", "detail_level", "link", "owner_view",
            "discipline", "underlay", "revit_verdict"
        };

        private const double Eps = 1e-6;

        private sealed class Ctx
        {
            public Document Host;
            public Document Doc;            // the document the element lives in (host, or a link's document)
            public View View;
            public Element El;
            public RevitLinkInstance Link;  // null for a host element
            public Transform T = Transform.Identity; // element document -> host coordinates
            public List<JObject> Reasons = new List<JObject>();
            public List<string> Passed = new List<string>();
            public List<JObject> NotApplicable = new List<JObject>();
            public bool InLink => Link != null;
        }

        public static JObject Explain(Document host, View view, RevitLinkInstance link, IList<long> ids)
        {
            Document edoc = host;
            Transform t = Transform.Identity;
            if (link != null) { edoc = link.GetLinkDocument(); t = link.GetTotalTransform(); }
            var elements = new JArray();
            foreach (long id in ids) elements.Add(One(host, edoc, view, link, t, id));
            return new JObject
            {
                ["view"] = DescribeView(host, view),
                ["link_instance"] = link == null ? (JToken)JValue.CreateNull() : new JObject { ["id"] = link.Id.Value.ToString(), ["name"] = link.Name ?? "", ["link_document"] = edoc?.Title ?? "" },
                ["elements"] = elements,
                ["model_changed"] = false
            };
        }

        public static JObject DescribeView(Document doc, View view)
        {
            var o = new JObject { ["id"] = view.Id.Value.ToString(), ["name"] = view.Name ?? "", ["view_type"] = view.ViewType.ToString() };
            try { o["detail_level"] = view.DetailLevel.ToString(); } catch (Exception) { }
            try { o["discipline"] = view.Discipline.ToString(); } catch (Exception) { }
            try { ElementId tid = view.ViewTemplateId; o["template"] = Valid(tid) ? (doc.GetElement(tid)?.Name ?? "") : ""; } catch (Exception) { }
            o["phase"] = NameOf(doc, view.get_Parameter(BuiltInParameter.VIEW_PHASE));
            o["phase_filter"] = NameOf(doc, view.get_Parameter(BuiltInParameter.VIEW_PHASE_FILTER));
            return o;
        }

        private static JObject One(Document host, Document edoc, View view, RevitLinkInstance link, Transform t, long id)
        {
            var row = new JObject { ["id"] = id.ToString() };
            Element el = null;
            try { el = edoc?.GetElement(new ElementId(id)); } catch (Exception) { }
            if (el == null)
            {
                row["found"] = false; row["visible"] = "unknown"; row["name"] = ""; row["category"] = "";
                row["reasons"] = new JArray(Reason("element", "unknown", $"No element with id {id} exists in {(edoc == null ? "the document" : edoc.Title)}" + (link == null ? "" : " (the linked document): pass link_instance_id only for an element that lives in a link, and the id from that link."), null, "Check the id, and that it is from this document."));
                row["passed"] = new JArray(); row["not_applicable"] = new JArray();
                return row;
            }
            var c = new Ctx { Host = host, Doc = edoc, View = view, El = el, Link = link, T = t };
            row["found"] = true; row["name"] = SafeName(el);
            row["category"] = el.Category?.Name ?? "";
            row["in_link"] = c.InLink;

            if (el is View || el is ElementType)
            {
                c.Reasons.Add(Reason("element", "hides", el is View ? "A view is not drawn inside another view." : "An element type is not an element in the model; it is never displayed.", null, "Ask for the instances of this type instead."));
                return Finish(row, c);
            }

            Step(c, "element_hidden", CheckHidden);
            Step(c, "temporary_hide", CheckTemporary);
            Step(c, "category", CheckCategory);
            Step(c, "subcategory", CheckSubcategories);
            Step(c, "filter", CheckFilters);
            Step(c, "view_template", CheckTemplate);
            Step(c, "workset", CheckWorkset);
            Step(c, "design_option", CheckDesignOption);
            Step(c, "phase", CheckPhase);
            Step(c, "crop_region", CheckCrop);
            Step(c, "view_range", CheckViewRange);
            Step(c, "section_box", CheckSectionBox);
            Step(c, "far_clip", CheckFarClip);
            Step(c, "detail_level", CheckDetailLevel);
            Step(c, "link", CheckLink);
            Step(c, "owner_view", CheckOwnerView);
            Step(c, "discipline", CheckDiscipline);
            Step(c, "underlay", CheckUnderlay);
            Step(c, "revit_verdict", CheckVerdict);
            AppendTemplateFix(c);
            return Finish(row, c);
        }

        private static JObject Finish(JObject row, Ctx c)
        {
            var ordered = c.Reasons.OrderBy(r => Array.IndexOf(Order, r.Value<string>("check")) < 0 ? 999 : Array.IndexOf(Order, r.Value<string>("check"))).ToList();
            for (int i = 0; i < ordered.Count; i++) ordered[i]["order"] = i + 1;
            row["visible"] = Derive(ordered);
            row["reasons"] = new JArray(ordered);
            row["passed"] = new JArray(c.Passed);
            row["not_applicable"] = new JArray(c.NotApplicable);
            row["unknown_checks"] = new JArray(ordered.Where(r => r.Value<string>("status") == "unknown").Select(r => r.Value<string>("check")).Distinct());
            row["suggested_fixes"] = new JArray(ordered.Where(r => r.Value<string>("status") != "info" && !string.IsNullOrEmpty(r.Value<string>("fix"))).Select(r => r.Value<string>("fix")).Distinct());
            return row;
        }

        public static string Derive(IEnumerable<JObject> reasons)
        {
            var s = reasons.Select(r => r.Value<string>("status")).ToList();
            if (s.Contains("hides")) return "no";
            if (s.Contains("unknown") || s.Contains("likely")) return "unknown";
            return "yes";
        }

        // ---------------------------------------------------------------- helpers

        private static JObject Reason(string check, string status, string text, JObject evidence, string fix)
        {
            return new JObject { ["check"] = check, ["status"] = status, ["reason"] = text, ["evidence"] = evidence ?? new JObject(), ["fix"] = fix ?? "" };
        }

        private static void Add(Ctx c, string check, string status, string text, JObject evidence = null, string fix = null) { c.Reasons.Add(Reason(check, status, text, evidence, fix)); }
        private static void Pass(Ctx c, string check) { if (!c.Passed.Contains(check)) c.Passed.Add(check); }
        private static void NotApplicable(Ctx c, string check, string why) { c.NotApplicable.Add(new JObject { ["check"] = check, ["why"] = why }); }
        private static void Unknown(Ctx c, string check, string why, string fix = null) { Add(c, check, "unknown", why, null, fix ?? "Check this one by hand in the view."); }

        /// <summary>One check. If it throws, that is reported as unknown with the message, never skipped.</summary>
        private static void Step(Ctx c, string check, Action<Ctx> run)
        {
            try { run(c); }
            catch (Exception e) { Unknown(c, check, "The check failed and could not decide: " + e.GetType().Name + ": " + e.Message); }
        }

        private static bool Valid(ElementId id) { return id != null && id != ElementId.InvalidElementId && id.Value > 0; }
        private static string SafeName(Element e) { try { return e.Name ?? ""; } catch (Exception) { return ""; } }
        private static string NameOf(Document doc, Parameter p)
        {
            try { ElementId id = p?.AsElementId(); return Valid(id) ? (doc.GetElement(id)?.Name ?? "") : ""; } catch (Exception) { return ""; }
        }

        private static BuiltInCategory Bic(Category cat)
        {
            long v = cat == null ? 0 : cat.Id.Value;
            return v < 0 && v > int.MinValue ? (BuiltInCategory)(int)v : BuiltInCategory.INVALID;
        }

        private static Category CategoryOf(Element el)
        {
            try
            {
                if (el is CurveElement ce && ce.LineStyle is GraphicsStyle gs && gs.GraphicsStyleCategory != null) return gs.GraphicsStyleCategory;
            }
            catch (Exception) { }
            return el.Category;
        }

        private static string TemplateName(Ctx c)
        {
            try { ElementId tid = c.View.ViewTemplateId; return Valid(tid) ? (c.Host.GetElement(tid)?.Name ?? "") : ""; } catch (Exception) { return ""; }
        }

        private static IEnumerable<XYZ> Corners(BoundingBoxXYZ bb, Transform extra)
        {
            Transform own = bb.Transform ?? Transform.Identity;
            foreach (double x in new[] { bb.Min.X, bb.Max.X })
                foreach (double y in new[] { bb.Min.Y, bb.Max.Y })
                    foreach (double z in new[] { bb.Min.Z, bb.Max.Z })
                        yield return extra.OfPoint(own.OfPoint(new XYZ(x, y, z)));
        }

        /// <summary>The element's box in HOST coordinates (through the link transform), or null.</summary>
        private static List<XYZ> HostCorners(Ctx c)
        {
            BoundingBoxXYZ bb = null;
            try { bb = c.El.ViewSpecific && !c.InLink ? c.El.get_BoundingBox(c.View) : c.El.get_BoundingBox(null); } catch (Exception) { }
            if (bb == null) return null;
            return Corners(bb, c.T).ToList();
        }

        private static string Mm(double feet) { return Math.Round(feet * 304.8).ToString("0") + " mm"; }

        // ---------------------------------------------------------------- 1. element hidden

        private static void CheckHidden(Ctx c)
        {
            if (c.InLink) { NotApplicable(c, "element_hidden", "Hide-in-view of an element inside a link is not stored in the host view; the link instance itself is checked under 'link'."); return; }
            bool can = c.El.CanBeHidden(c.View);
            bool hidden = c.El.IsHidden(c.View);
            if (hidden)
                Add(c, "element_hidden", "hides", "The element is hidden in this view (Hide in View > Elements).", new JObject { ["IsHidden"] = true, ["CanBeHidden"] = can },
                    "Select it through Reveal Hidden Elements (the light bulb), then Unhide Element, or Unhide in View.");
            else Pass(c, "element_hidden");
        }

        private static void CheckTemporary(Ctx c)
        {
            if (c.InLink) { NotApplicable(c, "temporary_hide", "Temporary hide/isolate applies to host elements; the link instance is checked under 'link'."); return; }
            if (!c.View.IsInTemporaryViewMode(TemporaryViewMode.TemporaryHideIsolate)) { Pass(c, "temporary_hide"); return; }
            if (!c.View.IsElementVisibleInTemporaryViewMode(TemporaryViewMode.TemporaryHideIsolate, c.El.Id))
                Add(c, "temporary_hide", "hides", "The view is in Temporary Hide/Isolate and this element is not among the visible ones.", new JObject { ["temporary_hide_isolate"] = true },
                    "Reset Temporary Hide/Isolate (the sunglasses icon, Reset Temporary Hide/Isolate).");
            else Add(c, "temporary_hide", "info", "The view is in Temporary Hide/Isolate, and this element is one of the visible ones.", new JObject { ["temporary_hide_isolate"] = true }, "");
        }

        // ---------------------------------------------------------------- 2. category and subcategory

        private static void CheckCategory(Ctx c)
        {
            Category cat = CategoryOf(c.El);
            if (cat == null) { Unknown(c, "category", "The element has no category, so category visibility cannot be tested."); return; }
            if (c.InLink && Bic(cat) == BuiltInCategory.INVALID) { Unknown(c, "category", $"The category \"{cat.Name}\" is a custom category of the link document; its host-view visibility can't be matched by id.", "Check Visibility/Graphics > Model Categories for this name."); return; }
            var hiddenNames = new List<string>();
            var ev = new JObject { ["category"] = cat.Name };
            bool any = false;
            for (Category k = cat; k != null; k = k.Parent)
            {
                ElementId kid = c.InLink ? new ElementId(Bic(k)) : k.Id;
                bool can = true;
                try { can = c.View.CanCategoryBeHidden(kid); } catch (Exception) { }
                if (can && c.View.GetCategoryHidden(kid)) { hiddenNames.Add(k.Name); any = true; }
            }
            if (any)
            {
                ev["hidden_category"] = string.Join(" > ", hiddenNames);
                Add(c, "category", "hides", $"The category \"{string.Join(" / ", hiddenNames)}\" is switched off in this view's Visibility/Graphics.", ev,
                    $"Turn on \"{hiddenNames[hiddenNames.Count - 1]}\" in Visibility/Graphics (Model or Annotation Categories tab).");
                return;
            }
            bool shown = true;
            try { shown = c.InLink ? true : cat.get_Visible(c.View); } catch (Exception) { }
            if (!shown)
            {
                ev["Category.Visible"] = false;
                Add(c, "category", "hides", $"Revit reports the category \"{cat.Name}\" as not visible in this view although it is not marked hidden (a category that this view type, discipline or template does not display).", ev,
                    "Check the view type and discipline, and whether the category appears in Visibility/Graphics for this view.");
                return;
            }
            Pass(c, "category");
        }

        private static void CheckSubcategories(Ctx c)
        {
            Category cat = CategoryOf(c.El);
            if (cat == null || c.InLink) { NotApplicable(c, "subcategory", cat == null ? "no category" : "linked element: subcategory ids belong to the link document"); return; }
            Category top = cat.Parent ?? cat;
            var hidden = new List<string>();
            foreach (Category sub in top.SubCategories)
            {
                bool can = true;
                try { can = c.View.CanCategoryBeHidden(sub.Id); } catch (Exception) { }
                if (can && sub.Id != cat.Id && c.View.GetCategoryHidden(sub.Id)) hidden.Add(sub.Name);
            }
            if (cat.Parent != null && c.View.GetCategoryHidden(cat.Id))
                Add(c, "subcategory", "hides", $"The element is drawn with the subcategory \"{cat.Name}\" (of \"{top.Name}\"), and that subcategory is switched off in this view.", new JObject { ["subcategory"] = cat.Name, ["category"] = top.Name },
                    $"Turn on the subcategory \"{cat.Name}\" under \"{top.Name}\" in Visibility/Graphics.");
            else if (hidden.Count > 0)
                Add(c, "subcategory", "info", $"Some subcategories of \"{top.Name}\" are switched off in this view ({string.Join(", ", hidden)}). Parts of the element drawn in them will be missing; the rest still shows.", new JObject { ["hidden_subcategories"] = new JArray(hidden) },
                    $"If parts are missing, turn on {string.Join(", ", hidden)} under \"{top.Name}\" in Visibility/Graphics.");
            else Pass(c, "subcategory");
        }

        // ---------------------------------------------------------------- 3. filters

        private static void CheckFilters(Ctx c)
        {
            if (c.InLink) { Unknown(c, "filter", "View filters are not evaluated against elements of a link by this tool (rules are tested in the host document only).", "Open Visibility/Graphics > Filters and check each filter's categories and rules against the link element."); return; }
            Category cat = CategoryOf(c.El);
            ICollection<ElementId> filters = c.View.GetFilters();
            if (filters.Count == 0) { Pass(c, "filter"); return; }
            bool problem = false;
            foreach (ElementId fid in filters)
            {
                FilterElement fe = c.Host.GetElement(fid) as FilterElement;
                if (fe == null) continue;
                bool enabled = true;
                try { enabled = c.View.GetIsFilterEnabled(fid); } catch (Exception) { }
                bool passes; string why;
                try { passes = Passes(c, fe, cat, out why); }
                catch (Exception e) { problem = true; Add(c, "filter", "unknown", $"The filter \"{fe.Name}\" could not be tested against the element: {e.Message}", new JObject { ["filter"] = fe.Name, ["filter_id"] = fid.Value.ToString() }, "Check this filter's rules by hand."); continue; }
                if (!passes) continue;
                var ev = new JObject { ["filter"] = fe.Name, ["filter_id"] = fid.Value.ToString(), ["enabled"] = enabled, ["matched_by"] = why };
                if (!enabled) { Add(c, "filter", "info", $"The filter \"{fe.Name}\" matches the element but is switched off in this view, so it has no effect.", ev, ""); continue; }
                bool visible = c.View.GetFilterVisibility(fid);
                OverrideGraphicSettings ogs = c.View.GetFilterOverrides(fid);
                int transparency = 0;
                try { transparency = ogs.Transparency; } catch (Exception) { }
                ev["visible"] = visible; ev["transparency"] = transparency;
                if (!visible) { problem = true; Add(c, "filter", "hides", $"The filter \"{fe.Name}\" matches the element and its Visibility is switched off in this view.", ev, $"Tick Visibility for the filter \"{fe.Name}\" in Visibility/Graphics > Filters, or change the filter so the element no longer passes it."); }
                else if (transparency >= 100) { problem = true; Add(c, "filter", "likely", $"The filter \"{fe.Name}\" matches the element and overrides surface transparency to 100%, which makes its surfaces invisible.", ev, $"Lower the Transparency override of the filter \"{fe.Name}\"."); }
                else if (transparency > 0) { Add(c, "filter", "info", $"The filter \"{fe.Name}\" matches the element and makes it {transparency}% transparent.", ev, ""); }
                else Add(c, "filter", "info", $"The filter \"{fe.Name}\" matches the element (visible, no transparency).", ev, "");
            }
            if (!problem) Pass(c, "filter");
        }

        private static bool Passes(Ctx c, FilterElement fe, Category cat, out string why)
        {
            why = "";
            if (fe is ParameterFilterElement pfe)
            {
                if (cat == null || !pfe.GetCategories().Contains(cat.Id)) return false;
                ElementFilter ef = pfe.GetElementFilter();
                if (ef == null) return false;
                bool ok = ef.PassesFilter(c.Doc, c.El.Id);
                if (ok) why = "parameter rules";
                return ok;
            }
            if (fe is SelectionFilterElement sfe)
            {
                bool ok = sfe.GetElementIds().Contains(c.El.Id);
                if (ok) why = "selection set";
                return ok;
            }
            throw new InvalidOperationException("filter type " + fe.GetType().Name + " is not tested");
        }

        // ---------------------------------------------------------------- 4. view template

        private static readonly string[] TemplateParams =
            { "VIS_GRAPHICS_MODEL", "VIS_GRAPHICS_ANNOTATION", "VIS_GRAPHICS_FILTERS", "VIEW_PHASE_FILTER", "VIEW_DETAIL_LEVEL" };

        private static void CheckTemplate(Ctx c)
        {
            string name = TemplateName(c);
            if (name.Length == 0) { Pass(c, "view_template"); return; }
            var controls = new JArray(); var free = new JArray();
            ICollection<ElementId> notControlled = c.View.GetNonControlledTemplateParameterIds();
            foreach (string pn in TemplateParams)
            {
                if (!Enum.TryParse(pn, out BuiltInParameter bip)) continue;
                (notControlled.Contains(new ElementId(bip)) ? free : controls).Add(pn);
            }
            Add(c, "view_template", "info", $"The view uses the view template \"{name}\", which controls Visibility/Graphics settings (a setting the template controls cannot be changed in the view).",
                new JObject { ["template"] = name, ["controlled_by_template"] = controls, ["not_controlled"] = free },
                $"Change it on the template \"{name}\" (this affects every view using it), or tick the setting as not included in the template, or set the view's template to <None>.");
        }

        /// <summary>A fix for a V/G reason on a templated view belongs on the template.</summary>
        private static void AppendTemplateFix(Ctx c)
        {
            string name = TemplateName(c);
            if (name.Length == 0) return;
            var covered = new HashSet<string> { "category", "subcategory", "filter", "workset", "design_option", "phase", "detail_level", "discipline" };
            foreach (JObject r in c.Reasons)
            {
                string st = r.Value<string>("status");
                if (covered.Contains(r.Value<string>("check")) && (st == "hides" || st == "likely") && !string.IsNullOrEmpty(r.Value<string>("fix")))
                    r["fix"] = r.Value<string>("fix") + $" (This view uses the template \"{name}\": if the template controls this setting, change it there.)";
            }
        }

        // ---------------------------------------------------------------- 5. workset

        private static void CheckWorkset(Ctx c)
        {
            if (c.InLink) { Unknown(c, "workset", "Worksets of a linked element are shown or hidden per link instance (Revit Links > Worksets), which is not read here.", "Check Manage Links > the link > Worksets."); return; }
            if (!c.Doc.IsWorkshared) { NotApplicable(c, "workset", "the model is not workshared"); return; }
            WorksetId wid = c.El.WorksetId;
            if (wid == WorksetId.InvalidWorksetId) { NotApplicable(c, "workset", "the element is not in a workset"); return; }
            Workset ws = c.Doc.GetWorksetTable().GetWorkset(wid);
            WorksetVisibility vis = c.View.GetWorksetVisibility(wid);
            var ev = new JObject { ["workset"] = ws.Name, ["view_setting"] = vis.ToString(), ["visible_by_default"] = ws.IsVisibleByDefault, ["open"] = ws.IsOpen };
            if (vis == WorksetVisibility.Hidden)
                Add(c, "workset", "hides", $"The workset \"{ws.Name}\" is set to Hidden in this view.", ev, $"Set the workset \"{ws.Name}\" to Visible in Visibility/Graphics > Worksets.");
            else if (vis == WorksetVisibility.UseGlobalSettings && !ws.IsVisibleByDefault)
                Add(c, "workset", "hides", $"This view uses the global workset settings and the workset \"{ws.Name}\" is not visible by default.", ev, $"Set \"{ws.Name}\" to Visible in this view's Worksets tab, or tick 'Visible in all views' for it in the Worksets dialog.");
            else Pass(c, "workset");
        }

        // ---------------------------------------------------------------- 6. design option

        private static void CheckDesignOption(Ctx c)
        {
            if (c.InLink) { Unknown(c, "design_option", "Design options of a linked element follow the link's own option settings, which are not read here."); return; }
            DesignOption opt = c.El.DesignOption;
            if (opt == null) { Pass(c, "design_option"); return; }
            var o = FmcDesignOption.Describe(c.Doc, opt);
            string label = o == null ? opt.Name : o.Value.set + " : " + o.Value.option;
            ElementId setId = opt.get_Parameter(BuiltInParameter.OPTION_SET_ID)?.AsElementId();
            ElementId shownId = null;
            if (Enum.TryParse("VIEWER_OPTION_VISIBILITY", out BuiltInParameter bip)) shownId = c.View.get_Parameter(bip)?.AsElementId();
            ElementId activeId = DesignOption.GetActiveDesignOptionId(c.Doc);
            DesignOption shown = Valid(shownId) ? c.Doc.GetElement(shownId) as DesignOption : null;
            DesignOption active = Valid(activeId) ? c.Doc.GetElement(activeId) as DesignOption : null;
            var ev = new JObject { ["design_option"] = label, ["primary"] = opt.IsPrimary, ["view_option"] = shown == null ? "Automatic" : shown.Name, ["active_option"] = active == null ? "main model" : active.Name };
            if (shownId == null) { Unknown(c, "design_option", $"The element is in the design option \"{label}\" but the view's option setting could not be read.", "Check the view's Design Options setting in its Properties."); return; }
            bool sameSet(DesignOption d) { ElementId s = d?.get_Parameter(BuiltInParameter.OPTION_SET_ID)?.AsElementId(); return s != null && setId != null && s == setId; }
            bool visible;
            string via;
            if (shown != null && sameSet(shown)) { visible = shown.Id == opt.Id; via = "the view is set to the option \"" + shown.Name + "\""; }
            else if (active != null && sameSet(active)) { visible = active.Id == opt.Id; via = "the view is on Automatic and the active option of the set is \"" + active.Name + "\""; }
            else { visible = opt.IsPrimary; via = "the view is on Automatic and the set's primary option is shown"; }
            if (visible) { Pass(c, "design_option"); return; }
            Add(c, "design_option", "hides", $"The element is in the design option \"{label}\", which this view does not show ({via}).", ev,
                $"Set the view's Design Options (view Properties > Visibility/Graphics > Design Options) to \"{label}\", or make that option active.");
        }

        // ---------------------------------------------------------------- 7. phase and phase filter

        private static void CheckPhase(Ctx c)
        {
            if (c.InLink) { Unknown(c, "phase", "Phases of a linked element are matched by the link's own phase mapping (Revit Links > Phases), not read here.", "Check the link's Phase settings in Manage Links, and the host view's phase."); return; }
            ElementId created = c.El.CreatedPhaseId;
            if (!Valid(created)) { NotApplicable(c, "phase", "the element has no phase (view-specific or non-phased)"); return; }
            Parameter pp = c.View.get_Parameter(BuiltInParameter.VIEW_PHASE);
            ElementId viewPhase = pp?.AsElementId();
            if (!Valid(viewPhase)) { Unknown(c, "phase", "The view has no phase, so the element's phase status could not be decided.", "Set a Phase in the view's Properties."); return; }
            ElementId demolished = c.El.DemolishedPhaseId;
            Parameter fp = c.View.get_Parameter(BuiltInParameter.VIEW_PHASE_FILTER);
            PhaseFilter pf = Valid(fp?.AsElementId()) ? c.Doc.GetElement(fp.AsElementId()) as PhaseFilter : null;
            ElementOnPhaseStatus status = c.El.GetPhaseStatus(viewPhase);
            var ev = new JObject
            {
                ["element_created"] = c.Doc.GetElement(created)?.Name ?? "",
                ["element_demolished"] = Valid(demolished) ? (c.Doc.GetElement(demolished)?.Name ?? "") : "(not demolished)",
                ["view_phase"] = c.Doc.GetElement(viewPhase)?.Name ?? "",
                ["phase_filter"] = pf?.Name ?? "(none)",
                ["status_in_view_phase"] = status.ToString()
            };
            if (pf == null) { Pass(c, "phase"); return; }
            PhaseStatusPresentation pres = pf.GetPhaseStatusPresentation(status);
            ev["presentation"] = pres.ToString();
            if (pres == PhaseStatusPresentation.DontShow)
            {
                string why = status == ElementOnPhaseStatus.Future ? "is created after the view's phase"
                    : status == ElementOnPhaseStatus.Demolished ? "was demolished before the view's phase"
                    : "has the status " + status;
                Add(c, "phase", "hides", $"The phase filter \"{pf.Name}\" does not show elements with the status {status}: the element (created {ev["element_created"]}, demolished {ev["element_demolished"]}) {why} (\"{ev["view_phase"]}\").", ev,
                    $"Change the view's Phase (now \"{ev["view_phase"]}\") or its Phase Filter (now \"{pf.Name}\"), or fix the element's Phase Created / Phase Demolished.");
            }
            else if (pres == PhaseStatusPresentation.ShowOverriden)
                Add(c, "phase", "info", $"The phase filter \"{pf.Name}\" shows this element ({status}) with overridden graphics.", ev, "");
            else Pass(c, "phase");
        }

        // ---------------------------------------------------------------- 8. crop, view range, section box, far clip

        private static void CheckCrop(Ctx c)
        {
            if (!c.View.CropBoxActive) { Pass(c, "crop_region"); return; }
            if (c.View is ViewSheet) { NotApplicable(c, "crop_region", "sheet"); return; }
            if (c.El.ViewSpecific && !c.InLink && !(c.El is Level)) { NotApplicable(c, "crop_region", "view-specific annotation: placed in this view's own coordinates"); return; }
            List<XYZ> pts = HostCorners(c);
            if (pts == null) { Unknown(c, "crop_region", "The crop region is on but the element has no bounding box, so it could not be compared.", "Check the crop region by hand."); return; }
            BoundingBoxXYZ crop = c.View.CropBox;
            Transform inv = crop.Transform.Inverse;
            var local = pts.Select(p => inv.OfPoint(p)).ToList();
            double minX = local.Min(p => p.X), maxX = local.Max(p => p.X), minY = local.Min(p => p.Y), maxY = local.Max(p => p.Y);
            bool outside = maxX < crop.Min.X - Eps || minX > crop.Max.X + Eps || maxY < crop.Min.Y - Eps || minY > crop.Max.Y + Eps;
            bool shaped = false;
            try { ViewCropRegionShapeManager m = c.View.GetCropRegionShapeManager(); shaped = m != null && m.ShapeSet; } catch (Exception) { }
            var ev = new JObject { ["crop_box_active"] = true, ["non_rectangular_crop"] = shaped, ["crop_width"] = Mm(crop.Max.X - crop.Min.X), ["crop_height"] = Mm(crop.Max.Y - crop.Min.Y) };
            if (outside)
                Add(c, "crop_region", "hides", "The element's bounding box lies completely outside the view's crop region." + (shaped ? " (Tested against the crop rectangle; the crop has a custom shape, which only makes the visible area smaller.)" : ""), ev,
                    "Enlarge or move the crop region (or switch Crop View off) so it covers the element, or open a view that contains it.");
            else if (shaped) Unknown(c, "crop_region", "The element's box is inside the crop rectangle, but the crop region has a custom (non-rectangular) shape that this tool does not test.", "Check the crop shape by hand (Edit Crop).");
            else Pass(c, "crop_region");
        }

        private static void CheckViewRange(Ctx c)
        {
            if (!(c.View is ViewPlan plan)) { NotApplicable(c, "view_range", "not a plan view"); return; }
            Category cat = CategoryOf(c.El);
            BuiltInCategory b = Bic(cat);
            if (cat == null || cat.CategoryType != CategoryType.Model || b == BuiltInCategory.OST_Levels || b == BuiltInCategory.OST_Grids || b == BuiltInCategory.OST_Rooms || b == BuiltInCategory.OST_Areas || c.El.ViewSpecific)
            { NotApplicable(c, "view_range", "this kind of element is not limited by the view range (annotation, level, grid, room, area)"); return; }
            List<XYZ> pts = HostCorners(c);
            if (pts == null) { Unknown(c, "view_range", "The element has no bounding box, so it could not be compared with the view range.", "Check the view range by hand (view Properties > View Range)."); return; }
            PlanViewRange pvr = plan.GetViewRange();
            double? top = Elevation(c, pvr, PlanViewPlane.TopClipPlane);
            double? bottom = Elevation(c, pvr, PlanViewPlane.BottomClipPlane);
            double? depth = Elevation(c, pvr, PlanViewPlane.ViewDepthPlane);
            double? low = bottom.HasValue && depth.HasValue ? Math.Min(bottom.Value, depth.Value) : (bottom ?? depth);
            double zmin = pts.Min(p => p.Z), zmax = pts.Max(p => p.Z);
            var ev = new JObject { ["element_z_from"] = Mm(zmin), ["element_z_to"] = Mm(zmax), ["top_clip"] = top.HasValue ? Mm(top.Value) : "unlimited/unresolved", ["lowest_of_bottom_and_view_depth"] = low.HasValue ? Mm(low.Value) : "unlimited/unresolved" };
            if (top.HasValue && zmin > top.Value + Eps)
                Add(c, "view_range", "hides", "The element is entirely above the view range's top clip plane.", ev, "Raise the Top (and Cut plane) offset in the view's View Range, or use a view whose range contains the element.");
            else if (low.HasValue && zmax < low.Value - Eps)
                Add(c, "view_range", "hides", "The element is entirely below the view range's view depth.", ev, "Lower the View Depth offset in the view's View Range, or use a view whose range contains the element.");
            else Pass(c, "view_range");
        }

        private static double? Elevation(Ctx c, PlanViewRange pvr, PlanViewPlane plane)
        {
            Level lvl = c.Host.GetElement(pvr.GetLevelId(plane)) as Level;
            return lvl == null ? (double?)null : lvl.Elevation + pvr.GetOffset(plane);
        }

        private static void CheckSectionBox(Ctx c)
        {
            if (!(c.View is View3D v3)) { NotApplicable(c, "section_box", "not a 3D view"); return; }
            if (!v3.IsSectionBoxActive) { Pass(c, "section_box"); return; }
            List<XYZ> pts = HostCorners(c);
            if (pts == null) { Unknown(c, "section_box", "The section box is on but the element has no bounding box.", "Check the section box by hand."); return; }
            BoundingBoxXYZ sb = v3.GetSectionBox();
            Transform inv = sb.Transform.Inverse;
            var l = pts.Select(p => inv.OfPoint(p)).ToList();
            bool outside = l.Max(p => p.X) < sb.Min.X - Eps || l.Min(p => p.X) > sb.Max.X + Eps
                        || l.Max(p => p.Y) < sb.Min.Y - Eps || l.Min(p => p.Y) > sb.Max.Y + Eps
                        || l.Max(p => p.Z) < sb.Min.Z - Eps || l.Min(p => p.Z) > sb.Max.Z + Eps;
            var ev = new JObject { ["section_box_active"] = true, ["perspective"] = v3.IsPerspective };
            if (outside) Add(c, "section_box", "hides", "The element's bounding box lies completely outside the 3D view's section box.", ev, "Resize the section box to include the element, or switch Section Box off in the view's Properties.");
            else Pass(c, "section_box");
        }

        private static void CheckFarClip(Ctx c)
        {
            if (!(c.View is ViewSection)) { NotApplicable(c, "far_clip", "not a section, elevation or detail view"); return; }
            int clip = -1;
            if (Enum.TryParse("VIEWER_BOUND_FAR_CLIPPING", out BuiltInParameter bip)) { Parameter p = c.View.get_Parameter(bip); if (p != null) clip = p.AsInteger(); }
            if (clip < 0) { Unknown(c, "far_clip", "The view's Far Clip setting could not be read.", "Check Far Clip Offset in the view's Properties."); return; }
            if (clip == 0) { Pass(c, "far_clip"); return; }
            Category cat = CategoryOf(c.El);
            if (cat == null || cat.CategoryType != CategoryType.Model || c.El.ViewSpecific) { NotApplicable(c, "far_clip", "annotation and view-specific elements are not limited by far clip"); return; }
            List<XYZ> pts = HostCorners(c);
            if (pts == null) { Unknown(c, "far_clip", "The element has no bounding box, so it could not be compared with the view depth.", "Check Far Clip Offset by hand."); return; }
            BoundingBoxXYZ crop = c.View.CropBox;
            Transform inv = crop.Transform.Inverse;
            var l = pts.Select(p => inv.OfPoint(p)).ToList();
            double zmin = l.Min(p => p.Z), zmax = l.Max(p => p.Z);
            var ev = new JObject { ["far_clip_setting"] = clip, ["view_depth_range"] = Mm(crop.Max.Z - crop.Min.Z) };
            if (zmax < crop.Min.Z - Eps) Add(c, "far_clip", "hides", "The element is entirely beyond the view's far clip plane.", ev, "Increase Far Clip Offset in the view's Properties (or set Far Clipping to No clip).");
            else if (zmin > crop.Max.Z + Eps) Add(c, "far_clip", "hides", "The element is entirely behind the view's cut plane (on the viewer's side).", ev, "Move the section line/cut plane, or flip the view direction.");
            else Pass(c, "far_clip");
        }

        // ---------------------------------------------------------------- 9. detail level (best effort)

        private static void CheckDetailLevel(Ctx c)
        {
            Category cat = CategoryOf(c.El);
            if (cat == null || cat.CategoryType != CategoryType.Model || c.El.ViewSpecific) { NotApplicable(c, "detail_level", "annotation, view-specific or category-less elements have no detail-level geometry"); return; }
            if (c.InLink) { Unknown(c, "detail_level", "Detail-level geometry of a linked element is not tested.", "Switch the view's detail level and look."); return; }
            ViewDetailLevel vdl = c.View.DetailLevel;
            bool inView = HasGeometry(c.El.get_Geometry(new Options { View = c.View, ComputeReferences = false }), 0);
            if (inView) { Pass(c, "detail_level"); return; }
            var levels = new JArray();
            foreach (ViewDetailLevel d in new[] { ViewDetailLevel.Coarse, ViewDetailLevel.Medium, ViewDetailLevel.Fine })
                if (HasGeometry(c.El.get_Geometry(new Options { DetailLevel = d, ComputeReferences = false }), 0)) levels.Add(d.ToString());
            var ev = new JObject { ["view_detail_level"] = vdl.ToString(), ["geometry_at"] = levels };
            if (levels.Count > 0 && !levels.Any(t => t.ToString() == vdl.ToString()))
                Add(c, "detail_level", "likely", $"The element has no geometry at this view's detail level ({vdl}); it has geometry at {string.Join(", ", levels)}.", ev, $"Change the view's Detail Level to {levels[levels.Count - 1]} (best effort: Revit's own geometry query was used).");
            else if (levels.Count == 0) Unknown(c, "detail_level", "The element returns no geometry at any detail level (it may be a non-graphic element), so detail level can't explain anything.", "Nothing to fix by detail level.");
            else Unknown(c, "detail_level", $"The element has geometry at the view's detail level ({vdl}) in general but the view query returned none.", "Check the view's graphics by hand.");
        }

        private static bool HasGeometry(GeometryElement ge, int depth)
        {
            if (ge == null || depth > 4) return false;
            foreach (GeometryObject go in ge)
            {
                if (go is Solid s && (s.Faces.Size > 0 || s.Volume > 0)) return true;
                if (go is Curve || go is Mesh || go is Face || go is PolyLine) return true;
                if (go is GeometryInstance gi && (HasGeometry(gi.GetInstanceGeometry(), depth + 1) || HasGeometry(gi.GetSymbolGeometry(), depth + 1))) return true;
                if (go is GeometryElement inner && HasGeometry(inner, depth + 1)) return true;
            }
            return false;
        }

        // ---------------------------------------------------------------- 10. linked model

        private static void CheckLink(Ctx c)
        {
            if (!c.InLink)
            {
                if (c.El is RevitLinkInstance self) LinkInstanceChecks(c, self);
                else NotApplicable(c, "link", "the element is not in a link");
                return;
            }
            LinkInstanceChecks(c, c.Link);
        }

        private static void LinkInstanceChecks(Ctx c, RevitLinkInstance link)
        {
            bool problem = false;
            if (link.IsHidden(c.View)) { problem = true; Add(c, "link", "hides", $"The link instance \"{link.Name}\" is hidden in this view.", new JObject { ["link_instance"] = link.Name }, "Unhide the link instance (Reveal Hidden Elements > Unhide Element)."); }
            Category lc = link.Category;
            if (lc != null && c.View.CanCategoryBeHidden(lc.Id) && c.View.GetCategoryHidden(lc.Id)) { problem = true; Add(c, "link", "hides", "The category \"Revit Links\" is switched off in this view.", new JObject { ["category"] = lc.Name }, "Turn on Revit Links in Visibility/Graphics > Model Categories."); }
            if (c.Host.IsWorkshared && link.WorksetId != WorksetId.InvalidWorksetId)
            {
                Workset ws = c.Host.GetWorksetTable().GetWorkset(link.WorksetId);
                WorksetVisibility v = c.View.GetWorksetVisibility(link.WorksetId);
                if (v == WorksetVisibility.Hidden || (v == WorksetVisibility.UseGlobalSettings && !ws.IsVisibleByDefault))
                { problem = true; Add(c, "link", "hides", $"The link instance is on the workset \"{ws.Name}\", which is not visible in this view.", new JObject { ["workset"] = ws.Name, ["view_setting"] = v.ToString() }, $"Make the workset \"{ws.Name}\" visible in this view."); }
            }
            RevitLinkGraphicsSettings g = c.View.GetLinkOverrides(link.Id);
            if (g != null)
            {
                var ev = new JObject { ["link_visibility_type"] = g.LinkVisibilityType.ToString() };
                if (g.LinkVisibilityType == LinkVisibility.ByLinkView)
                {
                    View lv = Valid(g.LinkedViewId) ? link.GetLinkDocument()?.GetElement(g.LinkedViewId) as View : null;
                    ev["linked_view"] = lv?.Name ?? "(none selected)";
                    if (lv == null) { problem = true; Add(c, "link", "unknown", "The link is displayed 'By Linked View' but no linked view is selected, so what it shows can't be decided.", ev, "In Visibility/Graphics > Revit Links, pick a linked view or use By Host View."); }
                    else { problem = true; Add(c, "link", "unknown", $"The link is displayed 'By Linked View' (\"{lv.Name}\"): what is visible follows that view's settings in the link, which this tool does not evaluate.", ev, $"Check the view \"{lv.Name}\" in the linked model, or switch the link to By Host View."); }
                }
                else if (g.LinkVisibilityType == LinkVisibility.Custom)
                { problem = true; Add(c, "link", "unknown", "The link has Custom display settings (its own categories, phases, filters or detail level); those are not evaluated here.", ev, "Open Visibility/Graphics > Revit Links > Custom and check the tabs."); }
            }
            if (!problem) Pass(c, "link");
        }

        // ---------------------------------------------------------------- 11. owner view

        private static void CheckOwnerView(Ctx c)
        {
            if (c.InLink) { NotApplicable(c, "owner_view", "linked element"); return; }
            ElementId owner = c.El.OwnerViewId;
            if (!Valid(owner)) { Pass(c, "owner_view"); return; }
            ElementId primary = ElementId.InvalidElementId;
            try { primary = c.View.GetPrimaryViewId(); } catch (Exception) { }
            if (owner == c.View.Id || (Valid(primary) && owner == primary)) { Add(c, "owner_view", "info", "The element is view-specific and belongs to this view (or its primary view).", new JObject { ["owner_view"] = c.View.Name }, ""); return; }
            string name = c.Doc.GetElement(owner)?.Name ?? owner.Value.ToString();
            Add(c, "owner_view", "hides", $"The element is view-specific and belongs to a different view (\"{name}\"); it is drawn only there.", new JObject { ["owner_view"] = name, ["owner_view_id"] = owner.Value.ToString() }, $"Open the view \"{name}\", or copy the element to this view.");
        }

        // ---------------------------------------------------------------- 12. discipline and underlay

        private static void CheckDiscipline(Ctx c)
        {
            ViewDiscipline d = c.View.Discipline;
            if (d == ViewDiscipline.Coordination || d == ViewDiscipline.Architectural) { Pass(c, "discipline"); return; }
            Add(c, "discipline", "info", $"The view's Discipline is {d}. In a non-coordination discipline Revit can show elements of other disciplines halftone or not at all (Hidden Line); the API does not say which discipline an element counts as, so this is not decided.",
                new JObject { ["view_discipline"] = d.ToString(), ["cannot_determine"] = true }, "If the element looks faded or is missing, set the view's Discipline to Coordination.");
        }

        private static void CheckUnderlay(Ctx c)
        {
            if (!(c.View is ViewPlan plan) || c.InLink) { NotApplicable(c, "underlay", c.InLink ? "linked element" : "not a plan view"); return; }
            ElementId baseLevel = plan.GetUnderlayBaseLevel();
            if (!Valid(baseLevel)) { Pass(c, "underlay"); return; }
            ElementId lid = c.El.LevelId;
            if (Valid(lid) && lid == baseLevel && plan.GenLevel != null && lid != plan.GenLevel.Id)
                Add(c, "underlay", "info", $"The element is on the level \"{c.Doc.GetElement(lid)?.Name}\", which is this view's Underlay: it is shown only as a faded underlay (not selectable, not at full graphics).", new JObject { ["underlay_level"] = c.Doc.GetElement(lid)?.Name ?? "" }, "Set the Underlay to <None> to remove it, or work in the plan of the element's own level.");
            else Pass(c, "underlay");
        }

        // ---------------------------------------------------------------- 13. Revit's own verdict

        private static void CheckVerdict(Ctx c)
        {
            Element probe = c.InLink ? c.Link : c.El;
            bool inView;
            try { inView = new FilteredElementCollector(c.Host, c.View.Id).WherePasses(new ElementIdSetFilter(new List<ElementId> { probe.Id })).GetElementCount() > 0; }
            catch (Exception e) { Unknown(c, "revit_verdict", "Revit's view collector could not be asked: " + e.Message); return; }
            var ev = new JObject { ["returned_by_view_collector"] = inView };
            try { ev["IsHidden"] = probe.IsHidden(c.View); ev["CanBeHidden"] = probe.CanBeHidden(c.View); } catch (Exception) { }
            bool found = c.Reasons.Any(r => r.Value<string>("status") == "hides");
            if (inView)
            {
                if (found) Add(c, "revit_verdict", "info", "Revit's view collector still returns this element although a reason above hides it: that collector does not apply crop, view range, section box or far clip, and may not apply every phase/graphics rule. Revit's own verdict is not 'hidden'.", ev, "");
                else Pass(c, "revit_verdict");
            }
            else if (!found)
                Add(c, "revit_verdict", "hides", "Revit's own view collector does not return this element for this view, although none of the checks above found why.", ev, "Check the view's Visibility/Graphics, template, phase filter and design option settings by hand.");
            else Add(c, "revit_verdict", "info", "Revit's own view collector also does not return this element for this view (agrees with the reasons above).", ev, "");
        }
    }
}
