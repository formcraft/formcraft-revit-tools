using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.DirectContext3D;
using Autodesk.Revit.DB.ExternalService;
using Newtonsoft.Json.Linq;

namespace revit_mcp_plugin.Shell
{
    /// <summary>
    /// Review pins (docs/PLAN_MARK_REVIEW.md, R4): every open ticket with a place shows as a pin at it, in 3D views and
    /// plans, drawn with DirectContext3D: on the screen only, never an element, so the model never changes and live models
    /// show them too. Read straight from the project's review register (no server call), and read again when the file
    /// changes. A pin is a mast and a diamond, coloured by priority (Critical red, High orange, Medium amber, Low grey).
    /// </summary>
    public sealed class ReviewPins : IDirectContext3DServer
    {
        private static readonly Guid Id = new Guid("8a2f61c4-5b0e-4f3a-9d6e-1c7b2e4a9f10");
        private static ReviewPins _server;

        private readonly Dictionary<string, (DateTime Stamp, List<(XYZ At, ColorWithTransparency Colour)> Pins)> _byFolder =
            new Dictionary<string, (DateTime, List<(XYZ, ColorWithTransparency)>)>(StringComparer.OrdinalIgnoreCase);

        /// <summary>Called at start-up: adds the pins to Revit's DirectContext3D service.</summary>
        public static void Register()
        {
            try
            {
                _server = new ReviewPins();
                var service = ExternalServiceRegistry.GetService(ExternalServices.BuiltInExternalServices.DirectContext3DService) as MultiServerService;
                if (service == null) return;
                service.AddServer(_server);
                IList<Guid> active = service.GetActiveServerIds();
                active.Add(Id);
                service.SetActiveServers(active);
            }
            catch (Exception) { /* no pins: everything else works */ }
        }

        public Guid GetServerId() => Id;
        public ExternalServiceId GetServiceId() => ExternalServices.BuiltInExternalServices.DirectContext3DService;
        public string GetName() => "Formcraft review pins";
        public string GetVendorId() => "FMC";
        public string GetDescription() => "Pins at the open Mark & Review tickets";
        public string GetApplicationId() => "";
        public string GetSourceId() => "";
        public bool UsesHandles() => false;
        public bool UseInTransparentPass(View view) => false;
        public bool CanExecute(View view) => view is View3D || view is ViewPlan;

        public Outline GetBoundingBox(View view)
        {
            var pins = Pins(view.Document);
            if (pins.Count == 0) return null;
            var lo = new XYZ(pins.Min(p => p.At.X), pins.Min(p => p.At.Y), pins.Min(p => p.At.Z));
            var hi = new XYZ(pins.Max(p => p.At.X), pins.Max(p => p.At.Y), pins.Max(p => p.At.Z) + Mast);
            return new Outline(lo - new XYZ(1, 1, 1), hi + new XYZ(1, 1, 1));
        }

        private const double Mast = 1500 / 304.8, Head = 150 / 304.8;

        public void RenderScene(View view, DisplayStyle displayStyle)
        {
            try
            {
                var pins = Pins(view.Document);
                if (pins.Count == 0) return;
                // each pin: a mast from the point up, and a diamond (four sloped edges and a square) at its top
                var verts = new List<VertexPositionColored>();
                var lines = new List<(int A, int B)>();
                foreach (var (at, colour) in pins)
                {
                    int b = verts.Count;
                    XYZ top = at + new XYZ(0, 0, Mast);
                    XYZ c = top + new XYZ(0, 0, Head);
                    verts.Add(new VertexPositionColored(at, colour));                          // 0 the point
                    verts.Add(new VertexPositionColored(top, colour));                         // 1 the mast top
                    verts.Add(new VertexPositionColored(c + new XYZ(Head, 0, 0), colour));     // 2..5 the diamond's middle
                    verts.Add(new VertexPositionColored(c + new XYZ(0, Head, 0), colour));
                    verts.Add(new VertexPositionColored(c + new XYZ(-Head, 0, 0), colour));
                    verts.Add(new VertexPositionColored(c + new XYZ(0, -Head, 0), colour));
                    verts.Add(new VertexPositionColored(c + new XYZ(0, 0, Head), colour));    // 6 its tip
                    lines.Add((b, b + 1));
                    for (int k = 0; k < 4; k++)
                    {
                        lines.Add((b + 2 + k, b + 2 + (k + 1) % 4));
                        lines.Add((b + 1, b + 2 + k));
                        lines.Add((b + 6, b + 2 + k));
                    }
                }
                var format = new VertexFormat(VertexFormatBits.PositionColored);
                var vb = new VertexBuffer(verts.Count * VertexPositionColored.GetSizeInFloats());
                vb.Map(verts.Count * VertexPositionColored.GetSizeInFloats());
                vb.GetVertexStreamPositionColored().AddVertices(verts);
                vb.Unmap();
                var ib = new IndexBuffer(lines.Count * IndexLine.GetSizeInShortInts());
                ib.Map(lines.Count * IndexLine.GetSizeInShortInts());
                var stream = ib.GetIndexStreamLine();
                foreach (var (a, bb) in lines) stream.AddLine(new IndexLine(a, bb));
                ib.Unmap();
                DrawContext.FlushBuffer(vb, verts.Count, ib, lines.Count * IndexLine.GetSizeInShortInts(), format, new EffectInstance(VertexFormatBits.PositionColored), PrimitiveType.LineList, 0, lines.Count);
            }
            catch (Exception) { /* a pin never breaks a view */ }
        }

        /// <summary>The open tickets' places in this model's project register, read again only when the file changed.</summary>
        private List<(XYZ At, ColorWithTransparency Colour)> Pins(Document doc)
        {
            var none = new List<(XYZ, ColorWithTransparency)>();
            string folder = MarkTool.ProjectFolder(doc);
            if (folder.Length == 0) return none;
            string file = Path.Combine(folder, "01_WIP", "_Reviews", "FMC_Review_Register.json");
            if (!File.Exists(file)) return none;
            DateTime stamp = File.GetLastWriteTimeUtc(file);
            if (_byFolder.TryGetValue(folder, out var cached) && cached.Stamp == stamp) return cached.Pins;
            var pins = new List<(XYZ, ColorWithTransparency)>();
            try
            {
                foreach (JObject i in (JObject.Parse(File.ReadAllText(file))["items"] as JArray ?? new JArray()).OfType<JObject>())
                {
                    string status = i.Value<string>("status") ?? "";
                    if (status == "Closed" || status == "Resolved" || i["to"] == null) continue;
                    if (!(i["where"]?["point_mm"] is JArray p) || p.Count != 3) continue;
                    var at = new XYZ(p[0].Value<double>() / 304.8, p[1].Value<double>() / 304.8, p[2].Value<double>() / 304.8);
                    if (at.IsZeroLength()) continue;   // a ticket with no real place (from BCF without a camera)
                    pins.Add((at, ColourOf(i.Value<string>("priority"))));
                }
            }
            catch (Exception) { /* a register being written: the last pins stay */ return cached.Pins ?? none; }
            _byFolder[folder] = (stamp, pins);
            return pins;
        }

        private static ColorWithTransparency ColourOf(string priority)
        {
            switch (priority)
            {
                case "Critical": return new ColorWithTransparency(220, 38, 38, 0);
                case "High": return new ColorWithTransparency(234, 120, 20, 0);
                case "Medium": return new ColorWithTransparency(214, 170, 30, 0);
                default: return new ColorWithTransparency(120, 120, 120, 0);
            }
        }
    }
}
