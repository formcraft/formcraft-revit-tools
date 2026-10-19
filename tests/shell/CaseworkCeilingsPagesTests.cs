using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>
    /// CW3 and CL3: Engineer › Casework and Engineer › Ceilings (boards CW_Pane, CL_Pane) on the boards' worked examples,
    /// the 12-unit kitchen and the 6.0 × 4.5 m tray ceiling. Every number is the engines' (fmc_casework, fmc_ceiling).
    /// </summary>
    public class CaseworkCeilingsPagesTests
    {
        private sealed class Pane
        {
            public MockCaseworkTools Casework { get; } = new MockCaseworkTools();
            public MockCeilingTools Ceilings { get; } = new MockCeilingTools();
            public MockAskTools Ask { get; } = new MockAskTools();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane(string section, ICeilingTools? ceilings = null)
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Settings.Set("settings.project.folder", @"Z:\Projects\F26001");
                Settings.Set("settings.project.code", "F26001");
                var licence = new MockLicenceService();
                Vm = new ShellViewModel(licence, new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService(),
                                        ask: Ask, casework: Casework, ceilings: ceilings ?? Ceilings);
                licence.SetSignedIn();
                Vm.SelectSectionCommand.Execute(Vm.Groups.SelectMany(g => g.Sections).Single(x => x.Name == section));
            }

            public IEnumerable<SettingItem> Items(SectionPage page) => page.Groups.SelectMany(g => g.Items);
            public SettingsGroup Group(SectionPage page, string startsWith) => page.Groups.First(g => g.Title.StartsWith(startsWith));
            public SettingButton Button(SectionPage page, string label) => Items(page).OfType<ButtonsSetting>().SelectMany(b => b.Buttons).First(b => b.Label == label);
            public ChoiceSetting Choice(SectionPage page, string label) => Items(page).OfType<ChoiceSetting>().First(c => c.Label == label);
            public string Footer => string.Join(",", Vm.FooterActions.Select(f => f.Label + (f.Command.CanExecute(null) ? "" : " (off)")));
        }

        /// <summary>A Revit-like ceiling tool: no sample, so the person types the room.</summary>
        private sealed class NoSampleCeilings : ICeilingTools
        {
            public List<string> Ran { get; } = new List<string>();
            public bool CanPlace => false;
            public CeilingRequest? Sample => null;
            public Task<CeilingDesigns> DesignsAsync(CeilingRequest request) { Ran.Add("designs"); return new MockCeilingTools().DesignsAsync(request); }
            public Task<CeilingEvaluation> EvaluateAsync(CeilingRequest request, string design) => new MockCeilingTools().EvaluateAsync(request, design);
            public Task<CeilingPack> PackAsync(CeilingRequest request, string design, string projectFolder, bool dryRun) => new MockCeilingTools().PackAsync(request, design, projectFolder, dryRun);
            public Task<ToolResult> PlaceAsync(CeilingRequest request, string design, bool dryRun) => new MockCeilingTools().PlaceAsync(request, design, dryRun);
        }

        // ---------- Casework ----------

        [Test]
        public async Task Casework_opens_on_the_boards_kitchen_with_the_five_step_bar()
        {
            var (steps, units, pieces, sheets, edge, standards) = Sta.Run(() =>
            {
                var p = new Pane("Casework");
                var bar = p.Vm.Casework.Top.OfType<StepBarSetting>().Single();
                var l = p.Vm.Casework.Last!;
                var std = p.Items(p.Vm.Casework).OfType<ReadOnlySetting>().Select(r => r.Label + "=" + r.Value).ToList();
                return (string.Join(",", bar.Steps.Select(s => s.Text)), l.UnitCount, l.Pieces, l.Sheets, l.EdgeM, std);
            });

            await Assert.That(steps).IsEqualTo("1 Room,2 Layouts,3 Check,4 Units,5 Outputs");
            await Assert.That(units).IsEqualTo(12);
            await Assert.That(pieces).IsEqualTo(120);
            await Assert.That(sheets).IsEqualTo(15);
            await Assert.That(edge).IsEqualTo(98.5);
            await Assert.That(standards).Contains("Sheet=2440 × 1220, kerf 4");
        }

        [Test]
        public async Task Lay_out_opens_the_layout_with_every_unit_from_the_engine()
        {
            var (step, rows, footer) = Sta.Run(() =>
            {
                var p = new Pane("Casework");
                p.Vm.Casework.LayOutCommand.Execute(null);
                var table = p.Group(p.Vm.Casework, "Layout from your run").Items.OfType<TableSetting>().Single();
                return (p.Vm.Casework.Step, table.Rows.Select(r => string.Join("|", r.Cells)).ToList(), p.Footer);
            });

            await Assert.That(step).IsEqualTo(1);
            await Assert.That(rows.Count).IsEqualTo(15);
            await Assert.That(rows[0]).IsEqualTo("K01|Corner 1000|A at 0|Door");
            await Assert.That(rows[1]).IsEqualTo("K02|Base 600|A at 1000|3 drawers");
            await Assert.That(rows[6]).IsEqualTo("K07|Cooker space 600|B at 1200|—");
            await Assert.That(footer).IsEqualTo("Back,Use this layout");
        }

        [Test]
        public async Task Place_shows_its_rolled_back_dry_run_and_places_only_after_a_yes()
        {
            var (canPlace, footer, note, title, details, before, after) = Sta.Run(() =>
            {
                var p = new Pane("Casework");
                var page = p.Vm.Casework;
                page.Go(2);
                var n = p.Group(page, "Place in the model").Items.OfType<NoteSetting>().First().Text;
                var can = page.PlaceCommand.CanExecute(null);
                var f = p.Footer;
                page.PlaceCommand.Execute(null);
                var t = p.Vm.Dialog!.Title;
                var d = p.Vm.Dialog.Items.OfType<ReadOnlySetting>().Single().Value;
                var b = string.Join(",", p.Casework.Ran.Where(r => r.StartsWith("place")));
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (can, f, n, t, d, b, string.Join(",", p.Casework.Ran.Where(r => r.StartsWith("place"))));
            });

            await Assert.That(canPlace).IsTrue();
            await Assert.That(footer).IsEqualTo("Back,Place 12 units");
            await Assert.That(note).Contains("rolls back");
            await Assert.That(title).IsEqualTo("Place 12 units?");
            await Assert.That(details).Contains("K02 Base 600");
            await Assert.That(details).Contains("no corner type");
            await Assert.That(before).IsEqualTo("place dry run");
            await Assert.That(after).IsEqualTo("place dry run,place");
        }

        [Test]
        public async Task The_unit_editor_sends_fronts_with_the_run_and_a_width_as_a_unit_list()
        {
            var (fronts, frontsMode, width, widthMode, panels) = Sta.Run(() =>
            {
                var p = new Pane("Casework");
                var page = p.Vm.Casework;
                page.Go(3);
                var panelRows = p.Group(page, "Panels").Items.OfType<TableSetting>().Single().Rows.Count;
                p.Choice(page, "Fronts").Selected = "2 drawers";
                var pending = page.PendingEdits;
                page.ApplyCommand.Execute(null);
                var f = p.Casework.LastRequest!.Fronts.TryGetValue("K02", out var v) ? v : "";
                var fm = p.Casework.LastRequest.Units == null ? "run" : "units";
                p.Choice(page, "Width").Selected = "450";
                page.ApplyCommand.Execute(null);
                var w = p.Casework.LastRequest!.Units!.Single(u => u.Mark == "K02").Width;
                return (pending + ":" + f, fm, w, p.Vm.Casework.Last!.FromUnitList, panelRows);
            });

            await Assert.That(fronts).IsEqualTo("1:2drawer");
            await Assert.That(frontsMode).IsEqualTo("run");
            await Assert.That(width).IsEqualTo(450);
            await Assert.That(widthMode).IsTrue();
            await Assert.That(panels).IsEqualTo(16);
        }

        [Test]
        public async Task The_workshop_pack_shows_its_dry_run_and_writes_only_after_a_yes()
        {
            var (title, before, after, cost) = Sta.Run(() =>
            {
                var p = new Pane("Casework");
                var page = p.Vm.Casework;
                page.Go(4);
                var c = p.Group(page, "Cost").Items.OfType<NoteSetting>().Single().Text;
                page.PackCommand.Execute(null);
                var t = p.Vm.Dialog!.Title;
                var b = string.Join(",", p.Casework.Ran.Where(r => r.StartsWith("pack")));
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (t, b, string.Join(",", p.Casework.Ran.Where(r => r.StartsWith("pack"))), c);
            });

            await Assert.That(title).IsEqualTo("Make the workshop pack?");
            await Assert.That(before).IsEqualTo("pack dry run");
            await Assert.That(after).IsEqualTo("pack dry run,pack");
            await Assert.That(cost).Contains("UGX 540,000–810,000 (1 of 12 lines)");
            await Assert.That(cost).Contains("never invented");
        }

        // ---------- Ceilings ----------

        [Test]
        public async Task Ceilings_open_on_the_boards_living_room_with_three_designs()
        {
            var (designs, design, board, sheets) = Sta.Run(() =>
            {
                var p = new Pane("Ceilings");
                var d = p.Vm.Ceilings.Designs!.Options.Select(o => $"{o.Id} {o.Kind} {o.HeightsText} {o.Sheets} {o.Lux}{(o.Recommended ? " rec" : "")}");
                return (string.Join("; ", d), p.Vm.Ceilings.Design, p.Vm.Ceilings.Evaluation!.BoardM2, p.Vm.Ceilings.Evaluation.Sheets);
            });

            await Assert.That(designs).IsEqualTo("A tray 2850 / 2550 13 258 rec; B raft 2850 / 2700 11 186; C coffer 2850 / 2650 14 64");
            await Assert.That(design).IsEqualTo("tray");
            await Assert.That(board).IsEqualTo(31.86);
            await Assert.That(sheets).IsEqualTo(13);
        }

        [Test]
        public async Task Ceiling_checks_flag_and_the_light_level_is_for_the_engineer()
        {
            var (rows, light, canPlace, footer) = Sta.Run(() =>
            {
                var p = new Pane("Ceilings");
                p.Vm.Ceilings.Go(2);
                var list = p.Items(p.Vm.Ceilings).OfType<CheckListSetting>().Single();
                var l = list.Rows.Single(r => r.Label == "Light level");
                return (list.Rows.Count, l.Status + "/" + l.Kind, p.Vm.Ceilings.PlaceCommand.CanExecute(null), p.Footer);
            });

            await Assert.That(rows).IsEqualTo(10);
            await Assert.That(light).IsEqualTo("Engineer/Info");
            await Assert.That(canPlace).IsFalse();
            await Assert.That(footer).IsEqualTo("Back,Place the ceiling (off)");
        }

        [Test]
        public async Task A_feature_change_goes_to_the_engine_as_the_brief()
        {
            var (width, drop, styles) = Sta.Run(() =>
            {
                var p = new Pane("Ceilings");
                var page = p.Vm.Ceilings;
                page.Go(3);
                p.Choice(page, "Width").Selected = "900";
                page.ApplyCommand.Execute(null);
                var q = p.Ceilings.LastRequest!;
                return (q.BulkheadWidthMm, q.BulkheadDropMm, string.Join(",", q.Styles));
            });

            await Assert.That(width).IsEqualTo(900.0);
            await Assert.That(drop).IsNull();
            await Assert.That(styles).IsEqualTo("tray,cove,cornice");
        }

        [Test]
        public async Task The_ceiling_pack_shows_its_dry_run_and_writes_only_after_a_yes()
        {
            var (title, ran, setout) = Sta.Run(() =>
            {
                var p = new Pane("Ceilings");
                var page = p.Vm.Ceilings;
                page.Go(4);
                var zones = p.Group(page, "Set-out").Items.OfType<TableSetting>().Single().Rows.Select(r => string.Join("|", r.Cells)).ToList();
                page.PackCommand.Execute(null);
                var t = p.Vm.Dialog!.Title;
                p.Vm.Dialog.ConfirmCommand!.Execute(null);
                return (t, string.Join(",", p.Ceilings.Ran.Where(r => r.StartsWith("pack"))), zones);
            });

            await Assert.That(title).IsEqualTo("Make the ceiling pack?");
            await Assert.That(ran).IsEqualTo("pack dry run,pack");
            await Assert.That(setout[0]).IsEqualTo("Field|2850|15.84 m²|7 (F1–F7)");
        }

        [Test]
        public async Task Without_a_room_nothing_is_guessed()
        {
            var (message, ran) = Sta.Run(() =>
            {
                var tools = new NoSampleCeilings();
                var p = new Pane("Ceilings", tools);
                p.Vm.Ceilings.ProposeCommand.Execute(null);
                return (p.Vm.Status, tools.Ran.Count);
            });

            await Assert.That(message).StartsWith("Give the room's name, its width and depth (mm)");
            await Assert.That(ran).IsEqualTo(0);
        }

        [Test]
        public async Task The_ask_box_opens_Ask_with_the_ceiling_as_context()
        {
            var (title, asked) = Sta.Run(() =>
            {
                var p = new Pane("Ceilings");
                p.Vm.Ceilings.Go(1);
                p.Vm.Ceilings.Question.Value = "why 13 sheets?";
                p.Vm.Ceilings.AskCommand.Execute(null);
                return (p.Vm.Body!.Title, p.Ask.Asked.Select(a => a.Question).LastOrDefault() ?? "");
            });

            await Assert.That(title).IsEqualTo("Ask › Ask");
            await Assert.That(asked).IsEqualTo("About the ceiling in L-01 Living (design A, Tray with 600 bulkhead and cove): why 13 sheets?");
        }
    }
}
