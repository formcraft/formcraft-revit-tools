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
            // R5: the selected clash test's open clashes into the project's review register, beside the marks made in Revit
            var send = new Button { Dock = DockStyle.Bottom, Height = 32, Text = "Send clashes to review", Enabled = false };
            tests.SelectedIndexChanged += (s, e) => send.Enabled = tests.SelectedItems.Count == 1;
            var note = new Label { Dock = DockStyle.Bottom, Height = 36, Padding = new Padding(8, 4, 8, 4), ForeColor = Color.DimGray,
                Text = "Read-only. Clashes go to the project's review register (Send); fixes go back to the Revit model through a person's yes." };

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
            send.Click += async (s, e) =>
            {
                if (tests.SelectedItems.Count != 1) return;
                string test = tests.SelectedItems[0].Text;
                string folder = NavisReview.ProjectFolder(NwApp.ActiveDocument?.FileName ?? "");
                if (folder.Length == 0) { MessageBox.Show("Save the Navisworks file inside the project folder (the one with 01_WIP): the tickets go to its review register.", "Formcraft"); return; }
                send.Enabled = false;
                note.Text = "Sending " + test + " to the review register…";
                try
                {
                    JObject r = await NavisReview.SendAsync(test, folder);
                    note.Text = r["error"] != null ? "Not sent: " + r.Value<string>("error")
                        : r["reasons"] != null ? "Not sent: " + string.Join(" ", r["reasons"].Select(x => x.ToString()))
                        : $"{test}: {(r["added"] as JArray)?.Count ?? 0} new tickets, {r.Value<int?>("skipped") ?? 0} skipped (resolved, or ticketed already). Open them in Revit's Review board.";
                }
                catch (Exception ex) { note.Text = "Not sent: " + ex.Message; }
                finally { send.Enabled = tests.SelectedItems.Count == 1; }
            };
            var panel = new Panel { Dock = DockStyle.Fill };
            panel.Controls.Add(tests);
            panel.Controls.Add(models);
            panel.Controls.Add(bridge);
            panel.Controls.Add(note);
            panel.Controls.Add(refresh);
            panel.Controls.Add(send);
            panel.HandleCreated += (s, e) => Fill();
            return panel;
        }

        public override void DestroyControlPane(Control pane) => pane?.Dispose();
    }
}
