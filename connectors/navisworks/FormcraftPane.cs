using System;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;
using Autodesk.Navisworks.Api.Plugins;
using Newtonsoft.Json.Linq;
using NwApp = Autodesk.Navisworks.Api.Application;

namespace Formcraft.Navis
{
    /// <summary>
    /// View › Windows › Formcraft: a pane docked in Navisworks (step 1, read-only). It shows whether Claude can reach this
    /// Navisworks, the models in the file and each clash test with its results by status. The full Formcraft pane, with
    /// the AI clash triage and its toggles, follows once the clash matrix is in the kit.
    /// </summary>
    [Plugin("FormcraftPane", "FMCF", DisplayName = "Formcraft", ToolTip = "Formcraft: models and clash tests")]
    [DockPanePlugin(360, 560, AutoScroll = true, MinimumWidth = 280)]
    public class FormcraftPane : DockPanePlugin
    {
        public override Control CreateControlPane()
        {
            var bridge = new Label { Dock = DockStyle.Top, Height = 40, Padding = new Padding(8), ForeColor = Color.DimGray };
            var models = new ListView { Dock = DockStyle.Top, Height = 140, View = View.Details, FullRowSelect = true, HeaderStyle = ColumnHeaderStyle.Nonclickable };
            models.Columns.Add("Model", 300);
            var tests = new ListView { Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, HeaderStyle = ColumnHeaderStyle.Nonclickable };
            tests.Columns.Add("Clash test", 150);
            tests.Columns.Add("Results", 60);
            tests.Columns.Add("New / Active", 90);
            tests.Columns.Add("Last run", 120);
            var refresh = new Button { Dock = DockStyle.Bottom, Height = 32, Text = "Refresh" };
            var note = new Label { Dock = DockStyle.Bottom, Height = 36, Padding = new Padding(8, 4, 8, 4), ForeColor = Color.DimGray,
                Text = "Read-only. Fixes go back to the Revit model through a person's yes." };

            void Fill()
            {
                bridge.Text = "Formcraft · " + NavisBridge.State;
                models.Items.Clear();
                tests.Items.Clear();
                if (NwApp.ActiveDocument == null || NwApp.ActiveDocument.IsClear) { models.Items.Add("No file open"); return; }
                try
                {
                    JObject info = NavisCommands.Info(NwApp.ActiveDocument);
                    foreach (JObject m in info["models"].OfType<JObject>()) models.Items.Add(System.IO.Path.GetFileName(m.Value<string>("source") is string s && s.Length > 0 ? s : m.Value<string>("file")));
                    foreach (JObject t in NavisCommands.Tests(NwApp.ActiveDocument)["tests"].OfType<JObject>())
                    {
                        var by = t["by_status"] as JObject ?? new JObject();
                        int open = (by.Value<int?>("New") ?? 0) + (by.Value<int?>("Active") ?? 0);
                        tests.Items.Add(new ListViewItem(new[] { t.Value<string>("name"), t.Value<string>("results"), open.ToString(), t.Value<string>("last_run") }));
                    }
                }
                catch (Exception e) { models.Items.Add("Couldn't read the file: " + e.Message); }
            }

            refresh.Click += (s, e) => Fill();
            var panel = new Panel { Dock = DockStyle.Fill };
            panel.Controls.Add(tests);
            panel.Controls.Add(models);
            panel.Controls.Add(bridge);
            panel.Controls.Add(note);
            panel.Controls.Add(refresh);
            panel.HandleCreated += (s, e) => Fill();
            return panel;
        }

        public override void DestroyControlPane(Control pane) => pane?.Dispose();
    }
}
