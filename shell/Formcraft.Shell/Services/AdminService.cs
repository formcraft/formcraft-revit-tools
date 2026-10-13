using System;
using System.Collections.Generic;
using System.Linq;

namespace Formcraft.Shell.Services
{
    public sealed class TeamMember
    {
        public TeamMember(string name, string revitUser, string role, string disciplines)
        {
            Name = name;
            RevitUser = revitUser;
            Role = role;
            Disciplines = disciplines;
        }

        public string Name { get; }
        public string RevitUser { get; }
        public string Role { get; set; }
        public string Disciplines { get; set; }
    }

    public sealed class AuditEntry
    {
        public AuditEntry(string when, string who, string change)
        {
            When = when;
            Who = who;
            Change = change;
        }

        public string When { get; }
        public string Who { get; }
        public string Change { get; }
    }

    public sealed class SeatLine
    {
        public SeatLine(FmcModule module, string used, string seats)
        {
            Module = module;
            Used = used;
            Seats = seats;
        }

        public FmcModule Module { get; }
        public string Used { get; }
        public string Seats { get; }
    }

    public sealed class SeatHolder
    {
        public SeatHolder(string person, string role, string modules, string lastCheck)
        {
            Person = person;
            Role = role;
            Modules = modules;
            LastCheck = lastCheck;
        }

        public string Person { get; }
        public string Role { get; }
        public string Modules { get; set; }
        public string LastCheck { get; }
    }

    public sealed class ModuleRequest
    {
        public ModuleRequest(string person, FmcModule module)
        {
            Person = person;
            Module = module;
        }

        public string Person { get; }
        public FmcModule Module { get; }
        public string Text => Person + " asks for " + Module;
    }

    /// <summary>
    /// The team, what each role may do, and the seats (boards core/PaneAdmin, account/PaneSeats). The team file beside the
    /// central model says who is who; seats come from the licence service (D6). Only admins reach any of this.
    /// Honest limit (board): roles hide and lock the plugin's own buttons; they are not a security wall.
    /// </summary>
    public interface IAdminService
    {
        IReadOnlyList<TeamMember> Team { get; }
        IReadOnlyList<string> Roles { get; }
        IReadOnlyList<string> Panes { get; }
        string Permission(string pane, string role);
        IReadOnlyList<AuditEntry> Audit { get; }
        string BackupAdmin { get; }
        IReadOnlyList<SeatLine> Seats { get; }
        IReadOnlyList<SeatHolder> SeatHolders { get; }
        IReadOnlyList<ModuleRequest> Requests { get; }
        /// <summary>Team-wide values (project settings, AI caps, rules): one store for the whole team.</summary>
        IUserSettings TeamValues { get; }

        string? AddPerson(string name, string revitUser, string role, string disciplines);
        string? ChangeRole(string revitUser, string role, string disciplines, string reason);
        void Remove(string revitUser);
        void SetPermission(string pane, string role, string value);
        void ResetPermissions();
        void PassAdmin(string revitUser, bool keepMeAsBackup);
        void Approve(ModuleRequest request);
        string? Invite(string email, string role, IEnumerable<FmcModule> modules);
        event EventHandler? Changed;
    }

    /// <summary>Sample team and seats as on the boards (people shown as [NAME X] placeholders). Changes live in memory.</summary>
    public sealed class MockAdminService : IAdminService
    {
        public static readonly string[] RoleNames = { "Admin", "Lead", "Modeller", "Reviewer", "Viewer" };
        public static readonly string[] PaneNames = { "Project", "Templates", "Families", "Sheets", "Annotate", "QA", "Reviews", "Workshare", "AI buttons" };

        // Board core/PaneAdmin "Permissions by role" (Adm, Lead, Mod, Rev, View).
        private static readonly Dictionary<string, string[]> Defaults = new Dictionary<string, string[]>
        {
            ["Project"] = new[] { "Full", "Read", "Read", "Read", "Read" },
            ["Templates"] = new[] { "Full", "Check", "Check", "—", "—" },
            ["Families"] = new[] { "Full", "Disc.", "Own", "Read", "—" },
            ["Sheets"] = new[] { "Full", "Disc.", "Place", "Read", "Read" },
            ["Annotate"] = new[] { "Full", "Live", "Own", "—", "—" },
            ["QA"] = new[] { "Full", "Fix", "Run", "Read", "Sum." },
            ["Reviews"] = new[] { "Full", "Close", "Fix", "Check", "Read" },
            ["Workshare"] = new[] { "Full", "Disc.", "Sync", "Read", "—" },
            ["AI buttons"] = new[] { "Caps", "Cap", "Cap", "Explain", "—" },
        };

        private readonly List<TeamMember> _team = new List<TeamMember>
        {
            new TeamMember("[NAME A]", "name.a", "Admin", "Z A"),
            new TeamMember("[NAME B]", "name.b", "Lead", "A"),
            new TeamMember("[NAME C]", "name.c", "Lead", "S M"),
            new TeamMember("[NAME D]", "name.d", "Modeller", "A"),
            new TeamMember("[NAME E]", "name.e", "Reviewer", "A S"),
            new TeamMember("Client QS", "viewer01", "Viewer", "—"),
        };

        private readonly List<AuditEntry> _audit = new List<AuditEntry>
        {
            new AuditEntry("13 Oct 10:42", "name.a", "name.d: Modeller → Lead (A)"),
            new AuditEntry("12 Oct 16:05", "name.a", "Annotate: Lead may run on live"),
            new AuditEntry("12 Oct 09:30", "name.a", "Added name.e as Reviewer"),
            new AuditEntry("10 Oct 14:12", "name.b", "Proposed rule SHT-039 approved"),
        };

        private readonly Dictionary<string, string[]> _permissions = Defaults.ToDictionary(p => p.Key, p => (string[])p.Value.Clone());

        private readonly List<SeatHolder> _holders = new List<SeatHolder>
        {
            new SeatHolder("[NAME A]", "BIM Coordinator", "M F Mo", "Today"),
            new SeatHolder("[NAME C]", "Modeller", "M F", "Today"),
            new SeatHolder("[NAME D]", "QS / Commercial", "M B (requested)", "Yesterday"),
        };

        private readonly List<ModuleRequest> _requests = new List<ModuleRequest> { new ModuleRequest("[NAME D]", FmcModule.Build) };

        public event EventHandler? Changed;

        public IReadOnlyList<TeamMember> Team => _team;
        public IReadOnlyList<string> Roles => RoleNames;
        public IReadOnlyList<string> Panes => PaneNames;
        public IReadOnlyList<AuditEntry> Audit => _audit;
        public string BackupAdmin { get; private set; } = "name.b";
        public IUserSettings TeamValues { get; } = new InMemoryUserSettings();

        public IReadOnlyList<SeatLine> Seats { get; } = new[]
        {
            new SeatLine(FmcModule.Core, "9", "Unlimited"),
            new SeatLine(FmcModule.Manage, "7", "8"),
            new SeatLine(FmcModule.Flow, "9", "10"),
            new SeatLine(FmcModule.Model, "2", "2 trial"),
            new SeatLine(FmcModule.Build, "0", "0"),
        };

        public IReadOnlyList<SeatHolder> SeatHolders => _holders;
        public IReadOnlyList<ModuleRequest> Requests => _requests;

        public string Permission(string pane, string role) =>
            _permissions.TryGetValue(pane, out var row) ? row[Array.IndexOf(RoleNames, role)] : "—";

        public string? AddPerson(string name, string revitUser, string role, string disciplines)
        {
            name = (name ?? "").Trim();
            revitUser = (revitUser ?? "").Trim();
            if (name.Length == 0) return "Enter their name.";
            if (revitUser.Length == 0) return "Enter their Revit user name: the plugin matches it to decide what they see.";
            if (_team.Any(t => string.Equals(t.RevitUser, revitUser, StringComparison.OrdinalIgnoreCase))) return revitUser + " is already on the team.";
            _team.Add(new TeamMember(name, revitUser, role, string.IsNullOrWhiteSpace(disciplines) ? "—" : disciplines));
            Log("Added " + revitUser + " as " + role);
            return null;
        }

        public string? ChangeRole(string revitUser, string role, string disciplines, string reason)
        {
            var m = _team.FirstOrDefault(t => t.RevitUser == revitUser);
            if (m == null) return "Pick a person.";
            if ((reason ?? "").Trim().Length == 0) return "Give a reason: it goes in the audit log.";
            var was = m.Role;
            m.Role = role;
            if (!string.IsNullOrWhiteSpace(disciplines)) m.Disciplines = disciplines;
            Log(revitUser + ": " + was + " → " + role + (string.IsNullOrWhiteSpace(disciplines) ? "" : " (" + disciplines + ")") + " · " + reason!.Trim());
            return null;
        }

        public void Remove(string revitUser)
        {
            if (_team.RemoveAll(t => t.RevitUser == revitUser) > 0) Log("Removed " + revitUser);
        }

        public void SetPermission(string pane, string role, string value)
        {
            if (role == "Admin" || !_permissions.TryGetValue(pane, out var row)) return; // Admin rights only through Change role
            var i = Array.IndexOf(RoleNames, role);
            if (row[i] == value) return;
            row[i] = value;
            Log(pane + ": " + role + " → " + value);
        }

        public void ResetPermissions()
        {
            foreach (var p in Defaults) _permissions[p.Key] = (string[])p.Value.Clone();
            Log("Permissions reset to Formcraft defaults");
        }

        public void PassAdmin(string revitUser, bool keepMeAsBackup)
        {
            Log("Admin handover sent to " + revitUser + (keepMeAsBackup ? " (name.a stays backup admin)" : ""));
        }

        public void Approve(ModuleRequest request)
        {
            if (!_requests.Remove(request)) return;
            var holder = _holders.FirstOrDefault(h => h.Person == request.Person);
            if (holder != null) holder.Modules = holder.Modules.Replace(" (requested)", "");
            Log("Approved " + request.Module + " for " + request.Person);
        }

        public string? Invite(string email, string role, IEnumerable<FmcModule> modules)
        {
            email = (email ?? "").Trim();
            if (!email.Contains("@")) return "Enter their work email.";
            Log("Invited " + email + " as " + role + " (" + string.Join(", ", modules) + ")");
            return null;
        }

        private void Log(string change)
        {
            _audit.Insert(0, new AuditEntry(DateTime.Now.ToString("d MMM HH:mm"), "name.a", change));
            Changed?.Invoke(this, EventArgs.Empty);
        }
    }
}
