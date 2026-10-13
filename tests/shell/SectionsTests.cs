using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Formcraft.Shell.Services;
using Formcraft.Shell.ViewModels;

namespace Formcraft.Shell.Tests
{
    /// <summary>U03: the sections registry, parts switches and licence gating.</summary>
    public class SectionsTests
    {
        /// <summary>A mock licence whose modules a test can change.</summary>
        internal sealed class TestLicence : ILicenceService
        {
            public LicenceState Current { get; private set; } = LicenceState.SignedOut;
            public event EventHandler? Changed;

            public void Grant(params (FmcModule Module, ModuleStatus Status)[] modules)
            {
                var list = modules.Select(m => new ModuleLicence(m.Module, m.Status, null)).ToList();
                list.Add(new ModuleLicence(FmcModule.Core, ModuleStatus.Included, null));
                Current = new LicenceState(new Account("[NAME A]", "a@formcraft.example", "Formcraft", "BIM Coordinator", "Team"), list, DateTime.Now, 14);
                Changed?.Invoke(this, EventArgs.Empty);
            }

            public Task<SignInResult> SignInAsync(string email, string password) => throw new NotSupportedException();
            public Task<SignInResult> VerifyCodeAsync(string code) => throw new NotSupportedException();
            public Task CheckNowAsync() => Task.CompletedTask;
            public Task SignOutAsync() => Task.CompletedTask;
            public Task ReleaseSeatAsync() => Task.CompletedTask;
            public Task<bool> ActivateKeyAsync(string key) => Task.FromResult(false);
            public Task RequestModuleAsync(FmcModule module) => Task.CompletedTask;
        }

        private static readonly (FmcModule, ModuleStatus)[] Everything =
        {
            (FmcModule.Manage, ModuleStatus.Active), (FmcModule.Flow, ModuleStatus.Active),
            (FmcModule.Model, ModuleStatus.Active), (FmcModule.Build, ModuleStatus.Active),
        };

        private sealed class Pane
        {
            public TestLicence Licence { get; } = new TestLicence();
            public InMemoryUserSettings Settings { get; } = new InMemoryUserSettings();
            public ShellViewModel Vm { get; }

            public Pane(params (FmcModule, ModuleStatus)[] modules) : this(null, modules)
            {
            }

            public Pane(SectionRegistry? registry, params (FmcModule, ModuleStatus)[] modules)
            {
                Vm = new ShellViewModel(Licence, new MockConnectionService(), new MockDocumentContext(), Settings, registry);
                Licence.Grant(modules.Length == 0 ? Everything : modules);
            }

            public string Groups => string.Join(",", Vm.Groups.Select(g => g.Name));
            public string Sections(string group) => string.Join(",", Vm.Groups.Single(g => g.Name == group).Sections.Select(s => s.Name));
            public string? Tag(string section) => Vm.Groups.SelectMany(g => g.Sections).Single(s => s.Name == section).ModuleTag;
            public string Tools => string.Join(",", Vm.QuickTools);
        }

        private static T OnSta<T>(Func<T> read) => Sta.Run(read);

        [Test]
        public async Task Registry_loads_and_lists_every_section()
        {
            var registry = SectionRegistry.LoadEmbedded();

            await Assert.That(string.Join(",", registry.Groups.Select(g => g.Name))).IsEqualTo("Setup,Drawings,Team,Check,Engineer,Build");
            await Assert.That(registry.Sections.Count()).IsEqualTo(18);
            await Assert.That(string.Join(",", registry.QuickTools.Select(t => t.Name))).IsEqualTo("Touch,Section Box,Tag Tidy");
        }

        [Test]
        public async Task Parts_match_the_settings_boards()
        {
            var registry = SectionRegistry.LoadEmbedded();
            string Parts(FmcModule m) => string.Join(",", registry.Parts.Where(p => p.Module == m).Select(p => p.Name));

            // design/generators/gen_panes.py parts(...)
            await Assert.That(Parts(FmcModule.Manage)).IsEqualTo("Setup,Drawings,Team,Check");
            await Assert.That(Parts(FmcModule.Flow)).IsEqualTo("Touch,Sheet Layout,Tags,3D");
            await Assert.That(Parts(FmcModule.Model)).IsEqualTo("Systems,Structural,Quantities");
            await Assert.That(Parts(FmcModule.Build)).IsEqualTo("Views on the model,BoQ,Data package");
        }

        [Test]
        public async Task Every_section_points_at_a_board_that_exists()
        {
            var boards = Path.Combine(RepoRoot(), "design", "boards");
            var missing = SectionRegistry.LoadEmbedded().Sections
                .Where(s => !File.Exists(Path.Combine(boards, s.Board.Replace('/', Path.DirectorySeparatorChar) + ".dc.html")))
                .Select(s => s.Name + " -> " + s.Board).ToList();

            await Assert.That(string.Join("; ", missing)).IsEqualTo("");
        }

        [Test]
        public async Task A_typo_in_the_registry_fails_early()
        {
            const string json = "{\"parts\":[{\"id\":\"a.b\",\"module\":\"Manage\",\"name\":\"B\"}],\"groups\":[{\"name\":\"G\",\"parts\":[\"a.c\"],\"sections\":[{\"name\":\"S\",\"module\":\"Mange\",\"phase\":\"p\",\"board\":\"b\"}]}],\"quickTools\":[]}";
            string? message = null;
            try { SectionRegistry.Load(json); }
            catch (InvalidDataException e) { message = e.Message; }

            await Assert.That(message).IsNotNull();
            await Assert.That(message!).Contains("unknown part a.c");
            await Assert.That(message!).Contains("unknown module Mange");
        }

        [Test]
        public async Task Everything_shows_by_default()
        {
            var (groups, engineer, tools) = OnSta(() =>
            {
                var p = new Pane();
                return (p.Groups, p.Sections("Engineer"), p.Tools);
            });

            await Assert.That(groups).IsEqualTo("Setup,Drawings,Team,Check,Engineer,Build");
            await Assert.That(engineer).IsEqualTo("Brief,Systems,Structural");
            await Assert.That(tools).IsEqualTo("Touch,Section Box,Tag Tidy");
        }

        [Test]
        [Arguments("manage.setup", "Drawings,Team,Check,Engineer,Build")]
        [Arguments("manage.drawings", "Setup,Team,Check,Engineer,Build")]
        [Arguments("manage.team", "Setup,Drawings,Check,Engineer,Build")]
        [Arguments("manage.check", "Setup,Drawings,Team,Engineer,Build")]
        public async Task A_Manage_part_off_removes_its_group(string part, string groups)
        {
            var shown = OnSta(() =>
            {
                var p = new Pane();
                p.Settings.SetPart(part, false);
                return p.Groups;
            });

            await Assert.That(shown).IsEqualTo(groups);
        }

        [Test]
        public async Task Model_parts_hide_their_sections()
        {
            var (afterSystems, afterStructural) = OnSta(() =>
            {
                var p = new Pane();
                p.Settings.SetPart("model.systems", false);
                var a = p.Sections("Engineer");
                p.Settings.SetPart("model.structural", false);
                return (a, p.Sections("Engineer"));
            });

            await Assert.That(afterSystems).IsEqualTo("Brief,Structural");
            await Assert.That(afterStructural).IsEqualTo("Brief");
        }

        [Test]
        public async Task Flow_parts_hide_quick_tools_and_tags()
        {
            var (tools, sheetsTag, annotateTag) = OnSta(() =>
            {
                var p = new Pane();
                p.Settings.SetPart("flow.touch", false);
                p.Settings.SetPart("flow.tags", false);
                p.Settings.SetPart("flow.sheetlayout", false);
                return (p.Tools, p.Tag("Sheets"), p.Tag("Annotate"));
            });

            await Assert.That(tools).IsEqualTo("Section Box");
            await Assert.That(sheetsTag).IsNull();
            await Assert.That(annotateTag).IsNull();
        }

        [Test]
        public async Task Build_group_goes_only_when_all_three_parts_are_off()
        {
            var (oneOff, allOff) = OnSta(() =>
            {
                var p = new Pane();
                p.Settings.SetPart("build.views", false);
                p.Settings.SetPart("build.boq", false);
                var one = p.Groups.Contains("Build");
                p.Settings.SetPart("build.package", false);
                return (one, p.Groups.Contains("Build"));
            });

            await Assert.That(oneOff).IsTrue();
            await Assert.That(allOff).IsFalse();
        }

        [Test]
        public async Task An_unlicensed_module_shows_locked_and_has_no_switches()
        {
            var (groups, buildLocked, switchModules) = OnSta(() =>
            {
                var p = new Pane((FmcModule.Manage, ModuleStatus.Active), (FmcModule.Flow, ModuleStatus.Active));
                // Switched off while licensed earlier: ignored now, the sections show with the locked page.
                p.Settings.SetPart("build.views", false);
                p.Settings.SetPart("build.boq", false);
                p.Settings.SetPart("build.package", false);
                p.Vm.SelectGroupCommand.Execute(p.Vm.Groups.Single(g => g.Name == "Build"));
                return (p.Groups, p.Vm.Body!.Locked, string.Join(",", p.Vm.Parts.Select(m => m.Module)));
            });

            await Assert.That(groups).IsEqualTo("Setup,Drawings,Team,Check,Engineer,Build");
            await Assert.That(buildLocked).IsTrue();
            await Assert.That(switchModules).IsEqualTo("Manage,Flow");
        }

        [Test]
        public async Task A_licence_change_updates_the_pane_at_once()
        {
            var (before, after) = OnSta(() =>
            {
                var p = new Pane((FmcModule.Manage, ModuleStatus.Active));
                var b = (p.Vm.ShowQuickTools, string.Join(",", p.Vm.Parts.Select(m => m.Module)));
                p.Licence.Grant((FmcModule.Manage, ModuleStatus.Active), (FmcModule.Flow, ModuleStatus.Trial));
                return (b, (p.Vm.ShowQuickTools, string.Join(",", p.Vm.Parts.Select(m => m.Module))));
            });

            await Assert.That(before.Item1).IsFalse();
            await Assert.That(before.Item2).IsEqualTo("Manage");
            await Assert.That(after.Item1).IsTrue();
            await Assert.That(after.Item2).IsEqualTo("Manage,Flow");
        }

        [Test]
        public async Task The_open_section_moves_when_its_group_is_hidden_and_stays_otherwise()
        {
            var (stays, moved) = OnSta(() =>
            {
                var p = new Pane();
                p.Vm.SelectGroupCommand.Execute(p.Vm.Groups.Single(g => g.Name == "Team"));
                p.Settings.SetPart("manage.setup", false);
                var s = p.Vm.Body!.Title;
                p.Settings.SetPart("manage.team", false);
                return (s, p.Vm.Body!.Title);
            });

            await Assert.That(stays).IsEqualTo("Team › Review");
            await Assert.That(moved).IsEqualTo("Drawings › Sheets");
        }

        [Test]
        public async Task Every_part_off_says_how_to_get_them_back()
        {
            var (noParts, body) = OnSta(() =>
            {
                var p = new Pane((FmcModule.Manage, ModuleStatus.Active), (FmcModule.Model, ModuleStatus.Active), (FmcModule.Build, ModuleStatus.Active));
                foreach (var id in new[] { "manage.setup", "manage.drawings", "manage.team", "manage.check", "model.systems", "model.structural",
                                           "build.views", "build.boq", "build.package" })
                    p.Settings.SetPart(id, false);
                // Engineer › Brief has no part, so it stays: everything that can be switched off is off.
                return (p.Vm.ShowNoParts, p.Groups);
            });

            await Assert.That(noParts).IsFalse();
            await Assert.That(body).IsEqualTo("Engineer");
        }

        [Test]
        public async Task When_nothing_is_left_the_body_says_so()
        {
            const string json = "{\"parts\":[{\"id\":\"manage.a\",\"module\":\"Manage\",\"name\":\"A\"}]," +
                                "\"groups\":[{\"name\":\"A\",\"parts\":[\"manage.a\"],\"sections\":[{\"name\":\"QA\",\"module\":\"Manage\",\"phase\":\"p\",\"board\":\"manage/PaneQA\"}]}]," +
                                "\"quickTools\":[]}";
            var (noParts, body, backOn) = OnSta(() =>
            {
                var p = new Pane(SectionRegistry.Load(json));
                p.Settings.SetPart("manage.a", false);
                var r = (p.Vm.ShowNoParts, p.Vm.Body == null);
                p.Settings.SetPart("manage.a", true);
                return (r.Item1, r.Item2, p.Vm.Body?.Title);
            });

            await Assert.That(noParts).IsTrue();
            await Assert.That(body).IsTrue();
            await Assert.That(backOn).IsEqualTo("A › QA");
        }

        [Test]
        public async Task A_chip_in_Settings_switches_the_part()
        {
            var (groupsAfterOff, savedOff) = OnSta(() =>
            {
                var p = new Pane();
                var chip = p.Vm.Parts.Single(m => m.Module == FmcModule.Manage).Switches.Single(s => s.Name == "Team");
                chip.IsOn = false;
                return (p.Groups, !p.Settings.IsPartOn("manage.team"));
            });

            await Assert.That(groupsAfterOff).IsEqualTo("Setup,Drawings,Check,Engineer,Build");
            await Assert.That(savedOff).IsTrue();
        }

        [Test]
        public async Task Parts_are_saved_for_the_person_and_read_back()
        {
            var dir = Path.Combine(Path.GetTempPath(), "fmc-settings-" + Guid.NewGuid().ToString("N"));
            var path = Path.Combine(dir, "settings.json");
            try
            {
                var first = new JsonUserSettings(path);
                first.SetPart("flow.touch", false);
                first.SetPart("manage.team", false);
                first.SetPart("manage.team", true);

                var again = new JsonUserSettings(path);
                await Assert.That(again.IsPartOn("flow.touch")).IsFalse();
                await Assert.That(again.IsPartOn("manage.team")).IsTrue();
                await Assert.That(File.ReadAllText(path)).Contains("flow.touch");
            }
            finally
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
            }
        }

        [Test]
        public async Task A_broken_settings_file_is_kept_and_defaults_are_used()
        {
            var dir = Path.Combine(Path.GetTempPath(), "fmc-settings-" + Guid.NewGuid().ToString("N"));
            var path = Path.Combine(dir, "settings.json");
            Directory.CreateDirectory(dir);
            File.WriteAllText(path, "{ not json");
            try
            {
                var settings = new JsonUserSettings(path);
                await Assert.That(settings.IsPartOn("flow.touch")).IsTrue();
                await Assert.That(File.Exists(path + ".broken")).IsTrue();
            }
            finally
            {
                Directory.Delete(dir, true);
            }
        }

        private static string RepoRoot()
        {
            var dir = AppContext.BaseDirectory;
            while (dir != null && !File.Exists(Path.Combine(dir, "global.json"))) dir = Path.GetDirectoryName(dir);
            return dir ?? throw new InvalidOperationException("Repo root (global.json) not found");
        }
    }
}
