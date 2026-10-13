using System.Windows.Input;
using Formcraft.Shell.Services;

namespace Formcraft.Shell.ViewModels
{
    /// <summary>The states of board account/PaneStates. Not licensed and live model show in the section and the document banner.</summary>
    public enum PaneState { Normal, Offline, GraceOver, NotConnected, KitMissing, RevitBusy }

    /// <summary>
    /// The state banner: what happened, what still works, and the one next step (board account/PaneStates, "Rules for every
    /// state"). One at a time, the most urgent first.
    /// </summary>
    public sealed class StateBannerInfo
    {
        public StateBannerInfo(PaneState state, ChipKind kind, string says, string stillWorks, string? action = null, ICommand? command = null)
        {
            State = state;
            Kind = kind;
            Says = says;
            StillWorks = stillWorks;
            Action = action;
            Command = command;
        }

        public PaneState State { get; }
        public ChipKind Kind { get; }
        /// <summary>"What the pane says" on the board.</summary>
        public string Says { get; }
        /// <summary>"What still works" on the board.</summary>
        public string StillWorks { get; }
        public string? Action { get; }
        public ICommand? Command { get; }
        public bool HasAction => Action != null;
        public bool IsBusy => State == PaneState.RevitBusy;
    }

    /// <summary>What a module adds, for the locked page (board account/PaneStates: "What it adds").</summary>
    public static class ModulePitch
    {
        public static string WhatItAdds(FmcModule module) => module switch
        {
            FmcModule.Model => "Start from brief, MEP systems, structural checks, quantities",
            FmcModule.Manage => "Project setup, templates, families, sheets, reviews, QA and reports",
            FmcModule.Flow => "Touch, sheet layout, Tag Tidy, section box and the shortcuts standard",
            FmcModule.Build => "Views on the model, BoQ and rates, the data package, 4D and the web app",
            _ => "The pane, Connect, the log file and Help",
        };
    }
}
