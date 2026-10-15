using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>Flow › View range: the dialog over the pane after an area is drawn on a plan, and the rules it checks.</summary>
    public class FlowViewRangeTests
    {
        private static ViewRangeAreaRequest Request(bool ceiling = false) => new ViewRangeAreaRequest
        {
            ViewName = "Level 1",
            ViewKind = ceiling ? "Ceiling plan" : "Floor plan",
            CeilingPlan = ceiling,
            AssociatedLevel = "Level 1",
            Levels = new[] { new ViewRangeLevel("Level 0", -3000), new ViewRangeLevel("Level 1", 0), new ViewRangeLevel("Level 2", 3200) },
            Current = new ViewRangeValues(new ViewRangePlane(ViewRange.LevelAbove, 0), new ViewRangePlane("Level 1", 1200),
                                          new ViewRangePlane("Level 1", 0), new ViewRangePlane("Level 1", 0)),
            Area = ViewRange.Size(6400, 4200),
            Result = "Revit 2025's API can't make plan regions, so this makes a view of its own: FMC_VR_Level 1_1.",
        };

        private static ViewRangeValues Values(string top, double t, double cut, string bottom, double b, string depth, double d) =>
            new ViewRangeValues(new ViewRangePlane(top, t), new ViewRangePlane("Level 1", cut), new ViewRangePlane(bottom, b), new ViewRangePlane(depth, d));

        private sealed class Pane
        {
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }
            public List<ViewRangeValues> Applied { get; } = new List<ViewRangeValues>();

            public Pane(ViewRangeAreaRequest r)
            {
                Settings.SetBool(SettingKeys.SetupDone, true);
                Settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                Vm = new ShellViewModel(new MockLicenceService(), new MockConnectionService(), new MockDocumentContext(), Settings, theme: new ThemeService());
                Vm.ShowDialog(FlowViewRangeDialog.Create(r, v => { Applied.Add(v); return null; }));
            }

            public DialogViewModel Dialog => Vm.Dialog!;
            public TextSetting Box(string label) => Dialog.Items.OfType<TextSetting>().Single(t => t.Label.StartsWith(label));
            public ChoiceSetting Pick(string label) => Dialog.Items.OfType<ChoiceSetting>().Single(c => c.Label == label);
        }

        [Test]
        public async Task Opens_with_the_views_own_range_and_says_what_apply_makes()
        {
            var (labels, top, topOffset, cut, note, from) = Sta.Run(() =>
            {
                var p = new Pane(Request());
                return (string.Join(",", p.Dialog.Items.Where(i => i.HasLabel).Select(i => i.Label)),
                        p.Pick("Top").Selected, p.Box("Top offset").Value, p.Box("Cut plane").Value,
                        p.Dialog.Items.OfType<NoteSetting>().Single().Text,
                        p.Dialog.Items.OfType<ReadOnlySetting>().Single(i => i.Label == "Starts from").Hint);
            });

            await Assert.That(labels).IsEqualTo("Area,Starts from,Top,Top offset (mm),Cut plane offset (mm) from Level 1,Bottom,Bottom offset (mm),View depth,View depth offset (mm)");
            await Assert.That(top).IsEqualTo(ViewRange.LevelAbove);
            await Assert.That(topOffset).IsEqualTo("0");
            await Assert.That(cut).IsEqualTo("1200");
            await Assert.That(note).Contains("FMC_VR_Level 1_1");
            await Assert.That(from).Contains("no view-range presets");
        }

        [Test]
        public async Task A_ceiling_plan_has_no_bottom_row()
        {
            var labels = Sta.Run(() => string.Join(",", new Pane(Request(ceiling: true)).Dialog.Items.OfType<ChoiceSetting>().Select(c => c.Label)));

            await Assert.That(labels).IsEqualTo("Top,View depth");
        }

        [Test]
        public async Task Apply_sends_the_values_and_closes()
        {
            var (applied, open) = Sta.Run(() =>
            {
                var p = new Pane(Request());
                p.Box("Cut plane").Value = "1 500";
                p.Pick("Top").Selected = "Level 2";
                p.Box("Top offset").Value = "−200";
                p.Dialog.ConfirmCommand!.Execute(null);
                return (p.Applied.Single(), p.Vm.IsDialogOpen);
            });

            await Assert.That(applied.Cut.OffsetMm).IsEqualTo(1500);
            await Assert.That(applied.Cut.Level).IsEqualTo("Level 1");
            await Assert.That(applied.Top.Level).IsEqualTo("Level 2");
            await Assert.That(applied.Top.OffsetMm).IsEqualTo(-200);
            await Assert.That(open).IsFalse();
        }

        [Test]
        public async Task A_cut_above_the_top_stays_open_and_sends_nothing()
        {
            var (error, applied, open) = Sta.Run(() =>
            {
                var p = new Pane(Request());
                p.Box("Cut plane").Value = "3500";
                p.Dialog.ConfirmCommand!.Execute(null);
                return (p.Dialog.Error, p.Applied.Count, p.Vm.IsDialogOpen);
            });

            await Assert.That(error).Contains("cut plane is above the top");
            await Assert.That(applied).IsEqualTo(0);
            await Assert.That(open).IsTrue();
        }

        [Test]
        public async Task Words_in_an_offset_are_refused()
        {
            var (error, applied) = Sta.Run(() =>
            {
                var p = new Pane(Request());
                p.Box("View depth offset").Value = "low";
                p.Dialog.ConfirmCommand!.Execute(null);
                return (p.Dialog.Error, p.Applied.Count);
            });

            await Assert.That(error).Contains("View depth offset (mm): type a number");
            await Assert.That(applied).IsEqualTo(0);
        }

        [Test]
        public async Task Cancel_sends_nothing()
        {
            var (applied, open) = Sta.Run(() =>
            {
                var p = new Pane(Request());
                p.Dialog.CancelCommand.Execute(null);
                return (p.Applied.Count, p.Vm.IsDialogOpen);
            });

            await Assert.That(applied).IsEqualTo(0);
            await Assert.That(open).IsFalse();
        }

        [Test]
        public async Task The_planes_follow_Revits_order()
        {
            var r = Request();
            await Assert.That(ViewRange.Check(r, Values(ViewRange.LevelAbove, 0, 1200, "Level 1", 0, "Level 1", 0))).IsNull();
            await Assert.That(ViewRange.Check(r, Values(ViewRange.Unlimited, 0, 1200, "Level 1", 0, ViewRange.Unlimited, 0))).IsNull();
            await Assert.That(ViewRange.Check(r, Values(ViewRange.LevelAbove, 0, 1200, "Level 1", 1500, "Level 1", 0))!).Contains("bottom is above the cut plane");
            await Assert.That(ViewRange.Check(r, Values(ViewRange.LevelAbove, 0, 1200, ViewRange.LevelBelow, 0, "Level 1", 0))!).Contains("view depth is above the bottom");
            await Assert.That(ViewRange.Check(r, Values(ViewRange.LevelAbove, 0, 1200, ViewRange.LevelBelow, 0, ViewRange.LevelBelow, -300))).IsNull();
        }

        [Test]
        public async Task Level_above_needs_a_level_above()
        {
            var r = Request();
            r.AssociatedLevel = "Level 2";
            var problem = ViewRange.Check(r, Values(ViewRange.LevelAbove, 0, 1200, "Level 2", 0, "Level 2", 0));

            await Assert.That(problem!).Contains("no level above Level 2");
        }

        [Test]
        public async Task The_fallback_view_takes_the_next_free_number()
        {
            var name = ViewRange.NextViewName("Level 1", new[] { "Level 1", "FMC_VR_Level 1_1", "fmc_vr_level 1_2" });

            await Assert.That(name).IsEqualTo("FMC_VR_Level 1_3");
        }

        [Test]
        [Arguments("2300", 2300.0)]
        [Arguments("-300", -300.0)]
        [Arguments("−300", -300.0)]
        [Arguments("1 200", 1200.0)]
        [Arguments("+300 mm", 300.0)]
        public async Task Offsets_read_as_mm(string typed, double mm)
        {
            var ok = ViewRange.TryParseMm(typed, out var value);

            await Assert.That(ok).IsTrue();
            await Assert.That(value).IsEqualTo(mm);
        }

        [Test]
        public async Task The_quick_tool_runs_in_revit_and_says_what_to_do()
        {
            var (ran, status) = Sta.Run(() =>
            {
                var flow = new MockFlowTools();
                var settings = new InMemoryUserSettings();
                settings.SetBool(SettingKeys.SetupDone, true);
                settings.Set(SettingKeys.KitFolder, SetupTests.SampleKit);
                var vm = new ShellViewModel(new MockLicenceService(), new MockConnectionService(), new MockDocumentContext(), settings, theme: new ThemeService(), flow: flow);
                vm.QuickToolCommand.Execute("View range");
                return (string.Join(",", flow.Ran), vm.Status);
            });

            await Assert.That(ran).IsEqualTo("View range");
            await Assert.That(status).Contains("drag an area");
        }
    }
}
