using System;
using System.IO;
using RevitMCPCommandSet.Bridge;

internal static class Program
{
    static int _failed;

    static void Main()
    {
        DefaultsMatchTheSafeButtons();
        NeverAutoIsNotOverridable();
        ReminderButtonsThatSaveOrSyncAreRefused();
        MatchingUsesMessageAndDocumentAndScope();
        AMissingFileUsesDefaultsAndAChangeReloads();
        if (_failed > 0)
        {
            Console.Error.WriteLine(_failed + " dialog rule test(s) failed");
            Environment.Exit(1);
        }
        Console.WriteLine("dialog rule tests passed");
    }

    static void DefaultsMatchTheSafeButtons()
    {
        var rules = DialogRuleEngine.DefaultRules();
        Eq(Find(rules, "Dialog_Revit_AccessingFile").Answer, "log", "accessing file is log only");
        Eq(Find(rules, "Dialog_Revit_AccessingFile").Scope, "always", "accessing file scope");
        Eq(Find(rules, DialogRuleEngine.SaveReminderId).Answer, "CommandLink3", "do not save");
        Eq(Find(rules, DialogRuleEngine.SaveReminderId).Scope, "always", "save reminder always");
        Eq(Find(rules, DialogRuleEngine.SyncReminderId).Answer, "CommandLink3", "do not synchronize");
        Eq(Find(rules, DialogRuleEngine.SyncReminderId).Scope, "always", "sync reminder always");
        Eq(Find(rules, "Dialog_Revit_DocWarnDialog").Answer, "Ok", "doc warn");
        Eq(Find(rules, "Dialog_Revit_DocWarnDialog").Scope, "ai_jobs", "doc warn scope");
        Eq(Find(rules, "Dialog_Revit_PasteSimilarSymbolsPaste").Answer, "Ok", "paste");
        Eq(Find(rules, "Dialog_Revit_ExtendedErrorDialog").Answer, "Cancel", "extended error");
        Eq(Find(rules, "Dialog_Revit_SelectElement").Answer, "Cancel", "select element");
        True(DialogRuleEngine.TryAnswer("CommandLink3", out int? code, out string name) && code == 1003 && name == "CommandLink3", "1003");
        True(DialogRuleEngine.TryAnswer("Close", out int? close, out _) && close == 8, "close is 8");
        True(DialogRuleEngine.TryAnswer("Cancel", out int? cancel, out _) && cancel == 2, "cancel is 2");
    }

    static void NeverAutoIsNotOverridable()
    {
        foreach (string id in new[]
        {
            "TaskDialog_Save_File", "Dialog_Revit_RevitSaveOptions", "Dialog_Revit_PartitionsSaveToCentral",
            "TaskDialog_Worksets_Errors", "TaskDialog_Changes_Not_Saved", "TaskDialog_Fatal_Error_Occured",
            "TaskDialog_Serious_Error_Occurred_Recoverable", "TaskDialog_Local_Changes_Not_Synchronized_With_Central",
            "TaskDialog_Relinquish_All", "TaskDialog_Model_Upgrade",
        })
            True(DialogRuleEngine.NeverAuto(id), id);

        False(DialogRuleEngine.NeverAuto(DialogRuleEngine.SaveReminderId), "save reminder is exempt");
        False(DialogRuleEngine.NeverAuto(DialogRuleEngine.SyncReminderId), "sync reminder is exempt");
        False(DialogRuleEngine.NeverAuto("Dialog_Revit_DocWarnDialog"), "doc warn is not never-auto");
        False(DialogRuleEngine.NeverAuto("Dialog_Revit_ExtendedErrorDialog"), "extended error is not never-auto");

        string json = "{\"version\":1,\"rules\":[" +
            "{\"id\":\"bad\",\"enabled\":true,\"dialog_id\":\"TaskDialog_Save_File\",\"answer\":\"No\",\"scope\":\"always\"}," +
            "{\"id\":\"ok\",\"enabled\":true,\"dialog_id\":\"Dialog_Revit_DocWarnDialog\",\"answer\":\"Close\",\"scope\":\"ai_jobs\"}" +
            "]}";
        True(DialogRuleEngine.TryParse(json, out DialogRule[] rules, out _, out string[] ignored), "parse");
        Eq(rules.Length, 1, "never-auto rule is dropped");
        Eq(rules[0].DialogId, "Dialog_Revit_DocWarnDialog", "the safe rule remains");
        True(ignored.Length == 1 && ignored[0].Contains("Save_File"), "the dropped id is reported");

        var planted = new[]
        {
            new DialogRule { Id = "x", Enabled = true, DialogId = "TaskDialog_Save_File", Answer = "No", Scope = "always", Message = "", Document = "", Note = "" },
        };
        var decision = DialogRuleEngine.Decide(planted, "TaskDialog_Save_File", "Save?", "", true);
        False(decision.Act, "a planted save rule does not answer");
        True(decision.NeverAuto, "planted save rule is never auto");
        True(decision.Reason.StartsWith("left for a person"), decision.Reason);
    }

    static void ReminderButtonsThatSaveOrSyncAreRefused()
    {
        True(DialogRuleEngine.UnsafeReminderAnswer(DialogRuleEngine.SaveReminderId, 1001), "1001 saves");
        True(DialogRuleEngine.UnsafeReminderAnswer(DialogRuleEngine.SaveReminderId, 1002), "1002 saves");
        False(DialogRuleEngine.UnsafeReminderAnswer(DialogRuleEngine.SaveReminderId, 1003), "1003 does not save");
        False(DialogRuleEngine.UnsafeReminderAnswer(DialogRuleEngine.SyncReminderId, 1003), "1003 does not sync");
        False(DialogRuleEngine.UnsafeReminderAnswer(DialogRuleEngine.SyncReminderId, 8), "close does not sync");
        True(DialogRuleEngine.UnsafeReminderAnswer(DialogRuleEngine.SyncReminderId, 1001), "1001 syncs");
        var rules = new[]
        {
            new DialogRule { Id = "bad", Enabled = true, DialogId = DialogRuleEngine.SyncReminderId, Answer = "CommandLink1", Scope = "always", Message = "", Document = "", Note = "" },
            new DialogRule { Id = "good", Enabled = true, DialogId = DialogRuleEngine.SyncReminderId, Answer = "Close", Scope = "always", Message = "", Document = "", Note = "" },
        };
        var decision = DialogRuleEngine.Decide(rules, DialogRuleEngine.SyncReminderId, "Not synchronized", "Hostel", false);
        True(decision.Act && decision.Code == 8, "the unsafe link is skipped and Close is used");
    }

    static void MatchingUsesMessageAndDocumentAndScope()
    {
        var rules = new[]
        {
            new DialogRule
            {
                Id = "walls", Enabled = true, DialogId = "Dialog_Revit_DocWarnDialog", Answer = "Ok", Scope = "ai_jobs",
                Message = "wall", Document = "Hostel", Note = "",
            },
        };
        var hit = DialogRuleEngine.Decide(rules, "dialog_revit_docwarndialog", "Wall join", "Hostel A", true);
        True(hit.Act && hit.Code == 1, "message and document match during a job");
        var outside = DialogRuleEngine.Decide(rules, "Dialog_Revit_DocWarnDialog", "Wall join", "Hostel A", false);
        False(outside.Act, "ai_jobs does not answer outside a job");
        var otherDoc = DialogRuleEngine.Decide(rules, "Dialog_Revit_DocWarnDialog", "Wall join", "School", true);
        False(otherDoc.Matched, "document regex misses");
        var otherText = DialogRuleEngine.Decide(rules, "Dialog_Revit_DocWarnDialog", "Room", "Hostel", true);
        False(otherText.Matched, "message regex misses");
        var logged = DialogRuleEngine.Decide(DialogRuleEngine.DefaultRules(), "Dialog_Revit_AccessingFile", "", "", false);
        True(logged.Matched && !logged.Act && logged.Reason.StartsWith("logged only"), logged.Reason);
        var save = DialogRuleEngine.Decide(DialogRuleEngine.DefaultRules(), DialogRuleEngine.SaveReminderId, "not saved", "", false);
        True(save.Act && save.Code == 1003, "save reminder answers outside a job");
    }

    static void AMissingFileUsesDefaultsAndAChangeReloads()
    {
        string dir = Path.Combine(Path.GetTempPath(), "fmc-dialog-rules-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        string file = Path.Combine(dir, "fmc_dialog_rules.json");
        Environment.SetEnvironmentVariable("FMC_DIALOG_RULES", file);
        try
        {
            DialogRuleStore.Invalidate();
            var first = DialogRuleStore.Current();
            True(File.Exists(file), "a missing file is created");
            True(first.Length == DialogRuleEngine.DefaultRules().Length, "defaults are loaded");
            File.WriteAllText(file, "{\"version\":1,\"rules\":[{\"id\":\"only\",\"enabled\":true,\"dialog_id\":\"Dialog_Revit_SelectElement\",\"answer\":\"Cancel\",\"scope\":\"ai_jobs\"}]}");
            DialogRuleStore.Invalidate();
            var next = DialogRuleStore.Current();
            Eq(next.Length, 1, "a changed file is reloaded");
            Eq(next[0].DialogId, "Dialog_Revit_SelectElement", "the new rule is the one on disk");
        }
        finally
        {
            Environment.SetEnvironmentVariable("FMC_DIALOG_RULES", null);
            DialogRuleStore.Invalidate();
            try { Directory.Delete(dir, true); } catch (Exception) { /* temp */ }
        }
    }

    static DialogRule Find(DialogRule[] rules, string id)
    {
        for (int i = 0; i < rules.Length; i++) if (string.Equals(rules[i].DialogId, id, StringComparison.OrdinalIgnoreCase)) return rules[i];
        throw new InvalidOperationException("missing " + id);
    }

    static void Eq(object actual, object expected, string name)
    {
        if (!Equals(actual, expected)) Fail(name + ": expected " + expected + " got " + actual);
    }

    static void True(bool value, string name) { if (!value) Fail(name); }
    static void False(bool value, string name) { if (value) Fail(name); }

    static void Fail(string name)
    {
        _failed++;
        Console.Error.WriteLine("FAIL " + name);
    }
}
