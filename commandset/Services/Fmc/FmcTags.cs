using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Read for fmc_tags. No transaction.
    /// Host view collectors miss linked doors. OwnerViewId == view misses every model door.
    /// This read reports both, and the elements a correct tag pass would see.
    /// </summary>
    public class FmcTagsHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft tags";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_tags needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Result = Read(doc);
                    Result["resolved_document"] = FmcTarget.Resolved(doc);
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        internal static JObject Read(Document doc)
        {
            var sheets = new JArray();
            var onSheet = new Dictionary<long, List<string>>();
            foreach (ViewSheet sheet in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
            {
                var viewIds = new JArray();
                foreach (ElementId id in sheet.GetAllViewports())
                {
                    if (doc.GetElement(id) is not Viewport viewport) continue;
                    viewIds.Add(viewport.ViewId.Value.ToString());
                    if (!onSheet.TryGetValue(viewport.ViewId.Value, out List<string> list))
                    {
                        list = new List<string>();
                        onSheet[viewport.ViewId.Value] = list;
                    }
                    list.Add(sheet.Id.Value.ToString());
                }
                sheets.Add(new JObject
                {
                    ["id"] = sheet.Id.Value.ToString(),
                    ["number"] = sheet.SheetNumber ?? "",
                    ["name"] = sheet.Name ?? "",
                    ["issued"] = Issued(doc, sheet),
                    ["view_ids"] = viewIds,
                });
            }
            var views = new JArray();
            foreach (View view in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(view => !view.IsTemplate))
            {
                bool plan = view.ViewType == ViewType.FloorPlan;
                bool listed = plan || (onSheet.ContainsKey(view.Id.Value));
                if (!listed) continue;
                var row = new JObject
                {
                    ["id"] = view.Id.Value.ToString(),
                    ["name"] = view.Name ?? "",
                    ["view_type"] = view.ViewType.ToString(),
                    ["is_floor_plan"] = plan,
                    ["sheet_ids"] = new JArray(onSheet.TryGetValue(view.Id.Value, out List<string> ids) ? ids : new List<string>()),
                };
                if (plan) FillPlan(doc, view, row);
                views.Add(row);
            }
            return new JObject
            {
                ["read_only"] = true,
                ["title"] = doc.Title ?? "",
                ["path"] = doc.PathName ?? "",
                ["is_central"] = FmcPhaseIds.IsCentral(doc),
                ["sheets"] = sheets,
                ["views"] = views,
                ["tag_types"] = TagTypes(doc),
            };
        }

        static void FillPlan(Document doc, View view, JObject row)
        {
            var elements = new JArray();
            var tagged = new JArray();
            var tags = new JArray();
            var have = new HashSet<string>();
            int doorsDoc = Count(doc, null, BuiltInCategory.OST_Doors);
            int doorsView = 0, doorsLink = 0, doorsOwner = 0, windowsView = 0, windowsLink = 0, roomsView = 0, roomsLink = 0;
            foreach (Element door in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Doors).WhereElementIsNotElementType())
                if (door.OwnerViewId == view.Id) doorsOwner++;
            CollectHost(doc, view, BuiltInCategory.OST_Doors, "Doors", elements, ref doorsView);
            CollectHost(doc, view, BuiltInCategory.OST_Windows, "Windows", elements, ref windowsView);
            CollectHost(doc, view, BuiltInCategory.OST_Rooms, "Rooms", elements, ref roomsView);
            CollectLinks(doc, view, elements, ref doorsLink, ref windowsLink, ref roomsLink);
            CollectTags(doc, view, have, tagged, tags);
            row["elements"] = elements;
            row["tagged"] = tagged;
            row["tags"] = tags;
            row["diagnosis"] = new JObject
            {
                ["doors_in_document"] = doorsDoc,
                ["doors_in_view"] = doorsView,
                ["doors_in_links"] = doorsLink,
                ["doors_owner_view_match"] = doorsOwner,
                ["windows_in_view"] = windowsView,
                ["windows_in_links"] = windowsLink,
                ["rooms_in_view"] = roomsView,
                ["rooms_in_links"] = roomsLink,
                ["is_floor_plan"] = true,
            };
        }

        static void CollectHost(Document doc, View view, BuiltInCategory bic, string category, JArray elements, ref int count)
        {
            if (Hidden(view, bic)) return;
            foreach (Element element in new FilteredElementCollector(doc, view.Id).OfCategory(bic).WhereElementIsNotElementType())
            {
                bool placed = true;
                if (element is SpatialElement spatial && spatial.Area <= 0) placed = false;
                XYZ point = PointOf(element, view);
                var row = new JObject
                {
                    ["id"] = element.Id.Value.ToString(),
                    ["category"] = category,
                    ["source"] = "host",
                    ["link_id"] = "",
                    ["placed"] = placed,
                };
                if (point != null) { row["x"] = Mm(point.X); row["y"] = Mm(point.Y); }
                elements.Add(row);
                if (placed) count++;
            }
        }

        static void CollectLinks(Document doc, View view, JArray elements, ref int doors, ref int windows, ref int rooms)
        {
            foreach (RevitLinkInstance link in new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>())
            {
                Document linkDoc = link.GetLinkDocument();
                if (linkDoc == null) continue;
                try { if (link.IsHidden(view)) continue; } catch (Exception) { continue; }
                Transform transform = link.GetTotalTransform();
                CollectLinkCategory(link, linkDoc, view, transform, BuiltInCategory.OST_Doors, "Doors", elements, ref doors);
                CollectLinkCategory(link, linkDoc, view, transform, BuiltInCategory.OST_Windows, "Windows", elements, ref windows);
                CollectLinkCategory(link, linkDoc, view, transform, BuiltInCategory.OST_Rooms, "Rooms", elements, ref rooms);
            }
        }

        static void CollectLinkCategory(RevitLinkInstance link, Document linkDoc, View view, Transform transform, BuiltInCategory bic, string category, JArray elements, ref int count)
        {
            if (Hidden(view, bic)) return;
            foreach (Element element in new FilteredElementCollector(linkDoc).OfCategory(bic).WhereElementIsNotElementType())
            {
                bool placed = true;
                if (element is SpatialElement spatial && spatial.Area <= 0) placed = false;
                XYZ local = PointOf(element, null);
                if (local == null) continue;
                XYZ hostPoint = transform.OfPoint(local);
                if (!InCrop(view, hostPoint)) continue;
                var row = new JObject
                {
                    ["id"] = element.Id.Value.ToString(),
                    ["category"] = category,
                    ["source"] = "link",
                    ["link_id"] = link.Id.Value.ToString(),
                    ["link_name"] = linkDoc.Title ?? "",
                    ["placed"] = placed,
                    ["x"] = Mm(hostPoint.X),
                    ["y"] = Mm(hostPoint.Y),
                };
                elements.Add(row);
                if (placed) count++;
            }
        }

        static void CollectTags(Document doc, View view, HashSet<string> have, JArray tagged, JArray tags)
        {
            foreach (IndependentTag tag in new FilteredElementCollector(doc, view.Id).OfClass(typeof(IndependentTag)).Cast<IndependentTag>())
            {
                AddBox(tag, view, tags, "independent");
                try
                {
                    foreach (LinkElementId leid in tag.GetTaggedElementIds() ?? new List<LinkElementId>())
                        Remember(have, tagged, leid);
                }
                catch (Exception)
                {
                    foreach (ElementId id in tag.GetTaggedLocalElementIds() ?? new List<ElementId>())
                        Remember(have, tagged, "", id.Value.ToString());
                }
            }
            var roomTags = new FilteredElementCollector(doc, view.Id).OfClass(typeof(RoomTag)).Cast<RoomTag>().ToList();
            foreach (RoomTag tag in roomTags)
            {
                AddBox(tag, view, tags, "room");
                if (tag.Room != null) Remember(have, tagged, "", tag.Room.Id.Value.ToString());
            }
            foreach (RoomTag tag in roomTags.Where(item => item.Room == null))
            {
                try
                {
                    string number = tag.get_Parameter(BuiltInParameter.ROOM_NUMBER)?.AsString() ?? "";
                    if (number.Length == 0) continue;
                    XYZ head = null;
                    try { head = tag.TagHeadPosition; } catch (Exception) { head = null; }
                    head ??= (tag.Location as LocationPoint)?.Point;
                    if (head == null) continue;
                    MatchLinkedRoom(doc, number, head, have, tagged);
                }
                catch (Exception) { /* a linked room tag with no number is left untagged */ }
            }
        }

        static void MatchLinkedRoom(Document doc, string number, XYZ head, HashSet<string> have, JArray tagged)
        {
            double best = 2000.0 / 304.8;
            string bestId = "";
            string bestLink = "";
            foreach (RevitLinkInstance link in new FilteredElementCollector(doc).OfClass(typeof(RevitLinkInstance)).Cast<RevitLinkInstance>())
            {
                Document linkDoc = link.GetLinkDocument();
                if (linkDoc == null) continue;
                Transform transform = link.GetTotalTransform();
                foreach (SpatialElement room in new FilteredElementCollector(linkDoc).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType().Cast<SpatialElement>())
                {
                    string roomNumber = room.get_Parameter(BuiltInParameter.ROOM_NUMBER)?.AsString() ?? "";
                    if (!string.Equals(roomNumber, number, StringComparison.OrdinalIgnoreCase)) continue;
                    XYZ local = PointOf(room, null);
                    if (local == null) continue;
                    double distance = transform.OfPoint(local).DistanceTo(head);
                    if (distance < best)
                    {
                        best = distance;
                        bestId = room.Id.Value.ToString();
                        bestLink = link.Id.Value.ToString();
                    }
                }
            }
            if (bestId.Length > 0) Remember(have, tagged, bestLink, bestId);
        }

        static void Remember(HashSet<string> have, JArray tagged, LinkElementId leid)
        {
            if (leid == null) return;
            string link = leid.LinkInstanceId == null || leid.LinkInstanceId == ElementId.InvalidElementId ? "" : leid.LinkInstanceId.Value.ToString();
            ElementId element = leid.LinkedElementId;
            if (element == null || element == ElementId.InvalidElementId) return;
            Remember(have, tagged, link, element.Value.ToString());
        }

        static void Remember(HashSet<string> have, JArray tagged, string link, string id)
        {
            string key = link + ":" + id;
            if (!have.Add(key)) return;
            tagged.Add(new JObject { ["id"] = id, ["link_id"] = link });
        }

        static void AddBox(Element tag, View view, JArray tags, string kind)
        {
            BoundingBoxXYZ box = tag.get_BoundingBox(view);
            if (box == null) return;
            tags.Add(new JObject
            {
                ["id"] = tag.Id.Value.ToString(),
                ["kind"] = kind,
                ["min_x"] = Mm(box.Min.X),
                ["min_y"] = Mm(box.Min.Y),
                ["max_x"] = Mm(box.Max.X),
                ["max_y"] = Mm(box.Max.Y),
            });
        }

        static JArray TagTypes(Document doc)
        {
            var rows = new JArray();
            foreach (FamilySymbol symbol in new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>())
            {
                long cat = symbol.Category?.Id.Value ?? 0;
                string name = cat == (long)BuiltInCategory.OST_DoorTags ? "Doors"
                    : cat == (long)BuiltInCategory.OST_WindowTags ? "Windows"
                    : cat == (long)BuiltInCategory.OST_RoomTags ? "Rooms" : "";
                if (name.Length == 0) continue;
                rows.Add(new JObject { ["category"] = name, ["id"] = symbol.Id.Value.ToString(), ["name"] = symbol.FamilyName + ": " + symbol.Name });
            }
            return rows;
        }

        static bool Issued(Document doc, ViewSheet sheet)
        {
            foreach (ElementId id in sheet.GetAllRevisionIds())
                if (doc.GetElement(id) is Revision revision && revision.Issued) return true;
            Parameter date = sheet.get_Parameter(BuiltInParameter.SHEET_ISSUE_DATE) ?? sheet.LookupParameter("Sheet Issue Date");
            return date != null && !string.IsNullOrWhiteSpace(date.AsString() ?? date.AsValueString());
        }

        static int Count(Document doc, View view, BuiltInCategory bic)
        {
            FilteredElementCollector collector = view == null
                ? new FilteredElementCollector(doc)
                : new FilteredElementCollector(doc, view.Id);
            return collector.OfCategory(bic).WhereElementIsNotElementType().Count();
        }

        static bool Hidden(View view, BuiltInCategory bic)
        {
            try { return view.GetCategoryHidden(new ElementId(bic)); }
            catch (Exception) { return false; }
        }

        static bool InCrop(View view, XYZ point)
        {
            if (view == null || !view.CropBoxActive || view.CropBox == null) return true;
            BoundingBoxXYZ crop = view.CropBox;
            XYZ local = crop.Transform.Inverse.OfPoint(point);
            return local.X >= crop.Min.X - 1e-6 && local.X <= crop.Max.X + 1e-6 && local.Y >= crop.Min.Y - 1e-6 && local.Y <= crop.Max.Y + 1e-6;
        }

        internal static XYZ PointOf(Element element, View view)
        {
            if (element.Location is LocationPoint lp) return lp.Point;
            if (element.Location is LocationCurve lc && lc.Curve != null) return lc.Curve.Evaluate(0.5, true);
            BoundingBoxXYZ box = element.get_BoundingBox(view);
            return box == null ? null : (box.Min + box.Max) * 0.5;
        }

        static double Mm(double feet) => Math.Round(feet * 304.8, 1);
    }

    /// <summary>One transaction. One subtransaction per tag. Rooms use NewRoomTag. Linked doors use CreateLinkReference. No leaders.</summary>
    public class FmcTagsApplyHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public JObject Parameters { get; set; } = new JObject();
        public JObject Result { get; private set; } = new JObject();
        public string Error { get; private set; } = "";
        public bool WaitForCompletion(int timeoutMilliseconds = 10000) { _done.Reset(); return FmcBusy.Wait(_done, timeoutMilliseconds); }
        public string GetName() => "Formcraft tags apply";

        public void Execute(UIApplication app)
        {
            Result = new JObject();
            Error = "";
            try
            {
                string key = (Parameters?.Value<string>("document") ?? "").Trim();
                if (key.Length == 0)
                    throw new InvalidOperationException("[FMC-DOC-REQUIRED] fmc_tags_apply needs document. Refusing to use the active document.");
                using (FmcTarget target = FmcTarget.Resolve(app, Parameters, mayOpen: false))
                {
                    Document doc = target.Doc;
                    Refuse(doc);
                    var views = new JArray();
                    using (var transaction = new Transaction(doc, "Formcraft tags"))
                    {
                        transaction.Start();
                        try
                        {
                            foreach (JObject viewOp in (Parameters["views"] as JArray ?? new JArray()).OfType<JObject>())
                                views.Add(PlaceView(doc, viewOp));
                            transaction.Commit();
                        }
                        catch
                        {
                            if (transaction.HasStarted() && !transaction.HasEnded()) transaction.RollBack();
                            throw;
                        }
                    }
                    Result = new JObject { ["ok"] = true, ["views"] = views, ["saved"] = false, ["synced"] = false, ["resolved_document"] = FmcTarget.Resolved(doc) };
                }
            }
            catch (Exception ex) { Error = ex.Message; }
            finally { _done.Set(); }
        }

        private void Refuse(Document doc)
        {
            string blob = (doc.Title ?? "") + " " + (doc.PathName ?? "");
            if (Regex.IsMatch(blob, "hebert hostels", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("HEBERT HOSTELS is not written by fmc_tags.");
            if (FmcPhaseIds.IsCentral(doc)) throw new InvalidOperationException("A central model is not written by fmc_tags.");
            if (FmcTarget.IsProtected(doc.PathName ?? "", FmcTarget.Roots(Parameters)))
                throw new InvalidOperationException("The document is under a protected path.");
        }

        private static JObject PlaceView(Document doc, JObject viewOp)
        {
            var ids = new JArray();
            var skipped = new JArray();
            View view = long.TryParse(viewOp.Value<string>("view_id"), out long viewId) ? doc.GetElement(new ElementId(viewId)) as View : null;
            if (view == null || view.ViewType != ViewType.FloorPlan)
            {
                skipped.Add(new JObject { ["code"] = "FMC-TAGS-NOT-PLAN", ["reason"] = "That view is not a floor plan." });
                return new JObject { ["view_id"] = viewOp.Value<string>("view_id"), ["view"] = viewOp.Value<string>("view"), ["tag_ids"] = ids, ["skipped"] = skipped };
            }
            double z = view is ViewPlan plan && plan.GenLevel != null ? plan.GenLevel.Elevation : 0;
            foreach (JObject row in (viewOp["placed"] as JArray ?? new JArray()).OfType<JObject>())
            {
                using (var sub = new SubTransaction(doc))
                {
                    sub.Start();
                    try
                    {
                        Element tag = PlaceOne(doc, view, row, z);
                        if (tag == null) throw new InvalidOperationException("The tag was not created.");
                        sub.Commit();
                        ids.Add(tag.Id.Value.ToString());
                    }
                    catch (Exception ex)
                    {
                        try { if (sub.HasStarted()) sub.RollBack(); } catch (Exception) { }
                        skipped.Add(new JObject { ["element"] = row.Value<string>("element"), ["code"] = "FMC-TAGS-NO-TYPE", ["reason"] = ex.Message });
                    }
                }
            }
            return new JObject { ["view_id"] = view.Id.Value.ToString(), ["view"] = view.Name, ["tag_ids"] = ids, ["skipped"] = skipped };
        }

        private static Element PlaceOne(Document doc, View view, JObject row, double z)
        {
            string kind = row.Value<string>("kind") ?? "independent";
            string linkId = row.Value<string>("link_id") ?? "";
            if (!long.TryParse(row.Value<string>("element"), out long elementValue)) throw new InvalidOperationException("The element id is not a number.");
            var elementId = new ElementId(elementValue);
            XYZ point = new XYZ((row.Value<double?>("x") ?? 0) / 304.8, (row.Value<double?>("y") ?? 0) / 304.8, z);
            FamilySymbol symbol = Symbol(doc, row);
            if (symbol != null && !symbol.IsActive) symbol.Activate();
            if (kind == "room")
            {
                LinkElementId linkElement = linkId.Length == 0 || !long.TryParse(linkId, out long linkValue)
                    ? new LinkElementId(elementId)
                    : new LinkElementId(new ElementId(linkValue), elementId);
                RoomTag tag = doc.Create.NewRoomTag(linkElement, new UV(point.X, point.Y), view.Id);
                if (tag == null) return null;
                tag.HasLeader = false;
                if (symbol != null) tag.ChangeTypeId(symbol.Id);
                return tag;
            }
            Reference reference;
            if (linkId.Length > 0 && long.TryParse(linkId, out long linkInstance))
            {
                RevitLinkInstance link = doc.GetElement(new ElementId(linkInstance)) as RevitLinkInstance;
                Element linked = link?.GetLinkDocument()?.GetElement(elementId);
                if (link == null || linked == null) throw new InvalidOperationException("The linked element is not loaded. A host Reference cannot tag it.");
                reference = new Reference(linked).CreateLinkReference(link);
            }
            else
            {
                Element element = doc.GetElement(elementId) ?? throw new InvalidOperationException("The element is not in this model.");
                reference = new Reference(element);
            }
            if (symbol != null)
                return IndependentTag.Create(doc, symbol.Id, view.Id, reference, false, TagOrientation.Horizontal, point);
            return IndependentTag.Create(doc, view.Id, reference, false, TagMode.TM_ADDBY_CATEGORY, TagOrientation.Horizontal, point);
        }

        private static FamilySymbol Symbol(Document doc, JObject row)
        {
            if (long.TryParse(row.Value<string>("tag_type_id"), out long id) && doc.GetElement(new ElementId(id)) is FamilySymbol byId) return byId;
            string wanted = row.Value<string>("tag_type") ?? "";
            string category = row.Value<string>("category") ?? "";
            BuiltInCategory bic = category == "Windows" ? BuiltInCategory.OST_WindowTags : category == "Rooms" ? BuiltInCategory.OST_RoomTags : BuiltInCategory.OST_DoorTags;
            FamilySymbol first = null;
            foreach (FamilySymbol symbol in new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>())
            {
                if (symbol.Category == null || symbol.Category.Id.Value != (long)bic) continue;
                string name = symbol.FamilyName + ": " + symbol.Name;
                if (wanted.Length > 0 && (string.Equals(name, wanted, StringComparison.OrdinalIgnoreCase) || string.Equals(symbol.Name, wanted, StringComparison.OrdinalIgnoreCase)))
                    return symbol;
                first ??= symbol;
            }
            return first;
        }
    }
}
