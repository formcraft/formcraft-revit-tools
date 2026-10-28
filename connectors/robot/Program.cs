using System.Diagnostics;
using Microsoft.Win32;
using Newtonsoft.Json.Linq;
using RobotOM;

namespace Formcraft.Robot
{
    /// <summary>
    /// fmc-robot.exe status | send | calculate | results, with JSON on stdin and JSON on stdout. Track R of
    /// docs/PLAN_EXECUTION.md: Formcraft prepares and transfers; the engineer decides. It sets only the loads the caller
    /// sends with each case (bar_loads, kN/m; owner 28 Oct: preliminary runs from the kit's takedown) and the combinations
    /// it names, never chooses a section or a design code, and never signs anything.
    /// Robot's API works in SI units (m, N, N·m); the file it saves is the one the server's guard allowed.
    /// </summary>
    public static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            JObject input;
            try { string text = Console.In.ReadToEnd().TrimStart('\uFEFF').Trim(); input = JObject.Parse(text.Length > 0 ? text : "{}"); } // PowerShell pipes add a BOM
            catch (Exception e) { return Reply(new JObject { ["error"] = "The input isn't JSON: " + e.Message }, 2); }
            try
            {
                switch (args.FirstOrDefault())
                {
                    case "status": return Reply(Status(), 0);
                    case "send": return Reply(Send(input), 0);
                    case "calculate": return Reply(Calculate(input), 0);
                    case "results": return Reply(Results(input), 0);
                    case "select": return Reply(Select(input), 0);
                    case "selection": return Reply(Selection(input), 0);
                    default: return Reply(new JObject { ["error"] = "Use status, send, calculate, results, select or selection" }, 2);
                }
            }
            catch (Exception e) { return Reply(new JObject { ["error"] = e.Message }, 1); }
        }

        private static int Reply(JObject o, int code)
        {
            Console.Out.Write(o.ToString(Newtonsoft.Json.Formatting.None));
            return code;
        }

        // ---------- status: installed? running? (never starts Robot) ----------

        private static JObject Status()
        {
            bool installed = Registry.ClassesRoot.OpenSubKey("Robot.Application") != null;
            bool running = Process.GetProcessesByName("robot").Length > 0;
            return new JObject { ["installed"] = installed, ["running"] = running };
        }

        private static IRobotApplication App(bool show)
        {
            IRobotApplication app = new RobotApplication();
            // owner 28 Oct: Robot's own pop-ups (save changes?, warnings) blocked the runs: no dialogs while automating;
            // Robot is handed back to the user (Interactive, UserControl) once the work is saved
            app.Interactive = 0;
            if (show) app.Visible = 1;
            return app;
        }

        private static void HandBack(IRobotApplication app)
        {
            try { app.Interactive = 1; app.UserControl = true; } catch (Exception) { }
        }

        // ---------- send: the analytical model as a new Robot project ----------

        private static JObject Send(JObject p)
        {
            string rtd = p.Value<string>("rtd") ?? throw new ArgumentException("rtd is needed");
            var model = p["model"] as JObject ?? throw new ArgumentException("model is needed");
            var form = p["form"] as JObject ?? throw new ArgumentException("form is needed");
            string support = form.Value<string>("supports") ?? "";
            if (support != "Fixed" && support != "Pinned") throw new ArgumentException("The engineer chooses the column-base supports: Fixed or Pinned");
            var cases = (form["cases"] as JArray ?? new JArray()).OfType<JObject>().ToList();
            if (cases.Count == 0) throw new ArgumentException("The engineer names at least one load case");

            IRobotApplication app = App(show: true);
            IRobotProject project = app.Project;
            // the previous project closes without the "save changes?" question (every run is saved to its own .rtd)
            try { if (project.IsActive == 1) project.Close(); } catch (Exception) { }
            project.New(IRobotProjectType.I_PT_FRAME_3D);
            IRobotStructure st = project.Structure;

            // Nodes: the server has merged the ends within 1 mm and numbered them.
            foreach (JObject n in (model["nodes"] as JArray ?? new JArray()).OfType<JObject>())
                st.Nodes.Create(n.Value<int>("n"), n.Value<double>("x") / 1000, n.Value<double>("y") / 1000, n.Value<double>("z") / 1000);

            var unresolved = new JArray();
            var made = new HashSet<string>();
            var bars = new JArray();
            foreach (JObject b in (model["bars"] as JArray ?? new JArray()).OfType<JObject>())
            {
                int n = b.Value<int>("n");
                st.Bars.Create(n, b.Value<int>("start"), b.Value<int>("end"));
                string label = SectionLabel(st, b, made, unresolved);
                if (label.Length > 0) ((IRobotBar)st.Bars.Get(n)).SetLabel(IRobotLabelType.I_LT_BAR_SECTION, label);
                string material = Material(st, b);
                if (material.Length > 0) ((IRobotBar)st.Bars.Get(n)).SetLabel(IRobotLabelType.I_LT_MATERIAL, material);
                bars.Add(new JObject { ["n"] = n, ["id"] = b["id"], ["section"] = label, ["material"] = material });
            }

            // Supports at the column bases the server found; the engineer chose Fixed or Pinned.
            string supportName = "FMC_" + support;
            IRobotLabel sl = st.Labels.Create(IRobotLabelType.I_LT_SUPPORT, supportName);
            var sd = (IRobotNodeSupportData)sl.Data;
            sd.UX = 1; sd.UY = 1; sd.UZ = 1;
            int r = support == "Fixed" ? 1 : 0;
            sd.RX = r; sd.RY = r; sd.RZ = r;
            st.Labels.Store(sl);
            var supported = (model["supports"] as JArray ?? new JArray()).Select(x => x.Value<int>()).ToList();
            foreach (int node in supported) ((IRobotNode)st.Nodes.Get(node)).SetLabel(IRobotLabelType.I_LT_SUPPORT, supportName);

            // The engineer's load cases; self-weight only where the engineer ticked it. Loads are added in Robot.
            int number = 1;
            var made_cases = new JArray();
            foreach (JObject c in cases)
            {
                var nature = (IRobotCaseNature)Enum.Parse(typeof(IRobotCaseNature), "I_CN_" + (c.Value<string>("nature") ?? "PERMANENT").ToUpperInvariant());
                RobotSimpleCase sc = st.Cases.CreateSimple(number, c.Value<string>("name") ?? ("Case " + number), nature, IRobotCaseAnalizeType.I_CAT_STATIC_LINEAR);
                if (c.Value<bool?>("self_weight") == true)
                {
                    int i = sc.Records.New(IRobotLoadRecordType.I_LRT_DEAD);
                    IRobotLoadRecord rec = sc.Records.Get(i);
                    rec.SetValue((short)IRobotDeadRecordValues.I_DRV_Z, -1);
                    rec.SetValue((short)IRobotDeadRecordValues.I_DRV_ENTIRE_STRUCTURE, 1);
                }
                // owner 28 Oct ("do the calc in Robot"): the case's bar loads when the server sends them (kN/m, down),
                // one record per value so equal loads share a record
                int loadsAdded = 0;
                foreach (var g in (c["bar_loads"] as JArray ?? new JArray()).OfType<JObject>().GroupBy(l => Math.Round(l.Value<double>("w_kn_m"), 2)))
                {
                    int i = sc.Records.New(IRobotLoadRecordType.I_LRT_BAR_UNIFORM);
                    IRobotLoadRecord rec = sc.Records.Get(i);
                    rec.SetValue((short)IRobotBarUniformRecordValues.I_BURV_PZ, -g.Key * 1000);
                    rec.Objects.FromText(string.Join(" ", g.Select(l => l.Value<int>("bar"))));
                    loadsAdded += g.Count();
                }
                // node forces (kN; lateral storey forces of a seismic or wind case), one record per (fx, fy, fz)
                foreach (var g in (c["node_loads"] as JArray ?? new JArray()).OfType<JObject>()
                    .GroupBy(l => (Math.Round(l.Value<double?>("fx_kn") ?? 0, 2), Math.Round(l.Value<double?>("fy_kn") ?? 0, 2), Math.Round(l.Value<double?>("fz_kn") ?? 0, 2))))
                {
                    int i = sc.Records.New(IRobotLoadRecordType.I_LRT_NODE_FORCE);
                    IRobotLoadRecord rec = sc.Records.Get(i);
                    rec.SetValue((short)IRobotNodeForceRecordValues.I_NFRV_FX, g.Key.Item1 * 1000);
                    rec.SetValue((short)IRobotNodeForceRecordValues.I_NFRV_FY, g.Key.Item2 * 1000);
                    rec.SetValue((short)IRobotNodeForceRecordValues.I_NFRV_FZ, g.Key.Item3 * 1000);
                    rec.Objects.FromText(string.Join(" ", g.Select(l => l.Value<int>("node"))));
                    loadsAdded += g.Count();
                }
                made_cases.Add(new JObject { ["n"] = number, ["name"] = c.Value<string>("name"), ["self_weight"] = c.Value<bool?>("self_weight") == true, ["bar_loads"] = loadsAdded });
                number++;
            }
            // combinations: {name, kind ULS|SLS, factors {case name: factor}}
            foreach (JObject cb in (form["combinations"] as JArray ?? new JArray()).OfType<JObject>())
            {
                var kind = (cb.Value<string>("kind") ?? "ULS").ToUpperInvariant() == "SLS" ? IRobotCombinationType.I_CBT_SLS : IRobotCombinationType.I_CBT_ULS;
                RobotCaseCombination comb = st.Cases.CreateCombination(number, cb.Value<string>("name") ?? ("Comb " + number), kind, IRobotCaseNature.I_CN_PERMANENT, IRobotCaseAnalizeType.I_CAT_COMB);
                foreach (var kv in cb["factors"] as JObject ?? new JObject())
                {
                    var hit = made_cases.OfType<JObject>().FirstOrDefault(x => x.Value<string>("name") == kv.Key) ?? throw new ArgumentException($"combination {cb["name"]}: no case {kv.Key}");
                    comb.CaseFactors.New(hit.Value<int>("n"), kv.Value!.Value<double>());
                }
                made_cases.Add(new JObject { ["n"] = number, ["name"] = cb.Value<string>("name"), ["combination"] = kind == IRobotCombinationType.I_CBT_SLS ? "SLS" : "ULS" });
                number++;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(rtd)!);
            project.SaveAs(rtd);
            HandBack(app);
            return new JObject { ["rtd"] = rtd, ["nodes"] = (model["nodes"] as JArray)?.Count ?? 0, ["bars"] = bars, ["supports"] = supported.Count,
                ["cases"] = made_cases, ["unresolved_sections"] = unresolved, ["next"] = "In Robot the engineer adds the loads, combinations and design code, then runs the analysis" };
        }

        /// <summary>A catalogue section by the type's name, or a concrete rectangle from b and h; unresolved ones are listed for the engineer.</summary>
        private static string SectionLabel(IRobotStructure st, JObject b, HashSet<string> made, JArray unresolved)
        {
            string name = (b.Value<string>("section") ?? "").Trim();
            double bw = b.Value<double?>("b_mm") ?? 0, h = b.Value<double?>("h_mm") ?? 0;
            bool concrete = (b.Value<string>("material_class") ?? "") == "Concrete";
            string label = concrete && bw > 0 && h > 0 ? $"RC {bw:0}x{h:0}" : name;
            if (label.Length == 0) { unresolved.Add(new JObject { ["id"] = b["id"], ["why"] = "no type name" }); return ""; }
            if (made.Contains(label)) return label;
            IRobotLabel sec = st.Labels.Create(IRobotLabelType.I_LT_BAR_SECTION, label);
            var data = (IRobotBarSectionData)sec.Data;
            bool ok;
            if (concrete && bw > 0 && h > 0)
            {
                bool column = (b.Value<string>("kind") ?? "") == "column";
                data.Type = IRobotBarSectionType.I_BST_NS_RECT;
                data.ShapeType = column ? IRobotBarSectionShapeType.I_BSST_CONCR_COL_R : IRobotBarSectionShapeType.I_BSST_CONCR_BEAM_RECT;
                IRobotBarSectionConcreteData cd = data.Concrete;
                cd.SetValue(column ? IRobotBarSectionConcreteDataValue.I_BSCDV_COL_B : IRobotBarSectionConcreteDataValue.I_BSCDV_BEAM_B, bw / 1000);
                cd.SetValue(column ? IRobotBarSectionConcreteDataValue.I_BSCDV_COL_H : IRobotBarSectionConcreteDataValue.I_BSCDV_BEAM_H, h / 1000);
                data.CalcNonstdGeometry();
                ok = true;
            }
            else ok = data.LoadFromDBase(name) == 1 || data.LoadFromDBase(name.Replace("x", " x ")) == 1;
            if (!ok) { unresolved.Add(new JObject { ["id"] = b["id"], ["section"] = name, ["why"] = "not in Robot's section databases" }); return ""; }
            st.Labels.Store(sec);
            made.Add(label);
            return label;
        }

        /// <summary>The kit's grade (FMC_Concrete_Grade, FMC_Steel_Grade) when Robot's material database has it; else Robot's default.</summary>
        private static string Material(IRobotStructure st, JObject b)
        {
            string grade = (b.Value<string>("grade") ?? "").Trim();
            if (grade.Length == 0) return "";
            if (st.Labels.Exist(IRobotLabelType.I_LT_MATERIAL, grade) == 1) return grade;
            IRobotLabel m = st.Labels.Create(IRobotLabelType.I_LT_MATERIAL, grade);
            if (((IRobotMaterialData)m.Data).LoadFromDBase(grade) != 1) return "";
            st.Labels.Store(m);
            return grade;
        }

        private static IRobotProject Opened(string rtd, bool show)
        {
            IRobotApplication app = App(show);
            if (!File.Exists(rtd)) throw new FileNotFoundException("The Robot file isn't there: " + rtd);
            try { if (app.Project.IsActive == 1) app.Project.Close(); } catch (Exception) { }
            app.Project.Open(rtd);
            return app.Project;
        }

        // ---------- calculate: the engineer's run ----------

        private static JObject Calculate(JObject p)
        {
            string rtd = p.Value<string>("rtd") ?? throw new ArgumentException("rtd is needed");
            IRobotProject project = Opened(rtd, show: true);
            int status = project.CalcEngine.Calculate();
            project.SaveAs(rtd);
            HandBack(new RobotApplication());
            return new JObject { ["rtd"] = rtd, ["calculated"] = status == 0, ["status"] = status };
        }

        // ---------- results: each bar's governing axial force and moment ----------

        private static JObject Results(JObject p)
        {
            string rtd = p.Value<string>("rtd") ?? throw new ArgumentException("rtd is needed");
            IRobotProject project = Opened(rtd, show: false);
            IRobotStructure st = project.Structure;
            var all = st.Cases.GetAll();
            var cases = new List<(int Number, string Name)>();
            for (int i = 1; i <= all.Count; i++) { var c = (IRobotCase)all.Get(i); cases.Add((c.Number, c.Name)); }
            var forces = st.Results.Bars.Forces;
            var outBars = new JArray();
            foreach (JObject b in (p["bars"] as JArray ?? new JArray()).OfType<JObject>())
            {
                int n = b.Value<int>("n");
                double nEd = 0, mEd = 0, myEd = 0, mzEd = 0, vEd = 0;
                string nCase = "", mCase = "";
                foreach (var (num, name) in cases)
                    foreach (double at in new[] { 0.0, 0.25, 0.5, 0.75, 1.0 })
                    {
                        IRobotBarForceData f;
                        try { f = forces.Value(n, num, at); } catch (Exception) { continue; }
                        double nx = Math.Abs(f.FX) / 1000, m = Math.Max(Math.Abs(f.MY), Math.Abs(f.MZ)) / 1000;
                        if (nx > nEd) { nEd = nx; nCase = name; }
                        if (m > mEd) { mEd = m; mCase = name; }
                        myEd = Math.Max(myEd, Math.Abs(f.MY) / 1000); mzEd = Math.Max(mzEd, Math.Abs(f.MZ) / 1000);
                        vEd = Math.Max(vEd, Math.Max(Math.Abs(f.FY), Math.Abs(f.FZ)) / 1000);
                    }
                outBars.Add(new JObject { ["n"] = n, ["id"] = b["id"], ["ned_kn"] = Math.Round(nEd, 1), ["med_knm"] = Math.Round(mEd, 1), ["ned_case"] = nCase, ["med_case"] = mCase,
                    ["my_knm"] = Math.Round(myEd, 1), ["mz_knm"] = Math.Round(mzEd, 1), ["ved_kn"] = Math.Round(vEd, 1) });
            }
            // node displacements (mm), largest horizontal per node over the cases asked (drift checks)
            var outNodes = new JArray();
            var want = (p["node_cases"] as JArray ?? new JArray()).Select(x => x.Value<string>()).ToHashSet();
            foreach (int node in (p["nodes"] as JArray ?? new JArray()).Select(x => x.Value<int>()))
            {
                double ux = 0, uy = 0;
                foreach (var (num, name) in cases.Where(c => want.Count == 0 || want.Contains(c.Name)))
                {
                    try { var d = st.Results.Nodes.Displacements.Value(node, num); ux = Math.Max(ux, Math.Abs(d.UX) * 1000); uy = Math.Max(uy, Math.Abs(d.UY) * 1000); } catch (Exception) { }
                }
                outNodes.Add(new JObject { ["node"] = node, ["ux_mm"] = Math.Round(ux, 2), ["uy_mm"] = Math.Round(uy, 2) });
            }
            return new JObject { ["rtd"] = rtd, ["cases"] = cases.Count, ["bars"] = outBars, ["nodes"] = outNodes };
        }

        // ---------- select, selection: one selection across the apps (X1 of the hub plan) ----------

        /// <summary>
        /// The Robot already open, never a new one: selection is about what the engineer is looking at. It must have a
        /// project open; its run is the file's name (FEA-yyyymmdd-hhmm), which is how the identity map names its bars.
        /// </summary>
        private static (IRobotProject Project, string Run) OpenRobot()
        {
            if (Process.GetProcessesByName("robot").Length == 0) throw new InvalidOperationException("Robot isn't open: open the run's model in Robot first");
            IRobotApplication app = new RobotApplication();
            string file = app.Project.FileName ?? "";
            if (file.Length == 0) throw new InvalidOperationException("Robot has no saved project open");
            return (app.Project, Path.GetFileNameWithoutExtension(file));
        }

        /// <summary>Selects bars by number in the open project (only when it is the run they came from) and refreshes the view.</summary>
        private static JObject Select(JObject p)
        {
            var (project, run) = OpenRobot();
            string want = p.Value<string>("run") ?? "";
            var asked = (p["bars"] as JArray ?? new JArray()).Select(x => x.Value<int>()).Distinct().ToList();
            if (want.Length > 0 && !string.Equals(want, run, StringComparison.OrdinalIgnoreCase))
                return new JObject { ["run"] = run, ["selected"] = 0, ["missing"] = new JArray(asked), ["note"] = $"Robot has {run} open, not {want}: open {want}.rtd to see these bars" };
            IRobotStructure st = project.Structure;
            var found = asked.Where(n => st.Bars.Exist(n) == 1).ToList();
            IRobotSelection sel = st.Selections.Get(IRobotObjectType.I_OT_BAR);
            sel.Clear();
            if (found.Count > 0) sel.FromText(string.Join(" ", found));
            try { project.ViewMngr.Refresh(); } catch (Exception) { /* no view open: the selection still holds */ }
            return new JObject { ["run"] = run, ["selected"] = found.Count, ["bars"] = new JArray(found), ["missing"] = new JArray(asked.Except(found)) };
        }

        /// <summary>The bars selected in the open project, as numbers ("1to5 8" in Robot's own text, expanded).</summary>
        private static JObject Selection(JObject p)
        {
            var (project, run) = OpenRobot();
            IRobotSelection sel = project.Structure.Selections.Get(IRobotObjectType.I_OT_BAR);
            var bars = new JArray();
            for (int i = 1; i <= sel.Count; i++) bars.Add(sel.Get(i));
            return new JObject { ["run"] = run, ["file"] = project.FileName, ["text"] = sel.ToText(), ["bars"] = bars };
        }
    }
}
