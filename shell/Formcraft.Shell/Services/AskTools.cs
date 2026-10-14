using System.Collections.Generic;
using System.Threading.Tasks;

namespace Formcraft.Shell.Services
{
    /// <summary>One answer from Ask Claude: the text, what it read and what it cost.</summary>
    public sealed class AskAnswer
    {
        public bool Ok { get; set; }
        public string Text { get; set; } = "";
        public string Model { get; set; } = "";
        public List<string> ToolsUsed { get; } = new List<string>();
        public int Tokens { get; set; }
        public int BudgetLeft { get; set; }
    }

    /// <summary>Key (saved or not, never the key), model, budget, today's use, the read-only tools and the log.</summary>
    public sealed class AskStatus
    {
        public bool Ok { get; set; }
        public string Message { get; set; } = "";
        public bool KeySaved { get; set; }
        public string KeyFile { get; set; } = "";
        public string Model { get; set; } = "";
        public int DailyTokens { get; set; }
        public int UsedToday { get; set; }
        public int QuestionsToday { get; set; }
        public List<(string Name, string Description)> Tools { get; } = new List<(string, string)>();
        /// <summary>Time, tools, tokens, result: never the question or the answer (Manual 14.5).</summary>
        public List<(string Time, string Tools, int Tokens, string Result)> Log { get; } = new List<(string, string, int, string)>();
    }

    /// <summary>Ask Claude in the pane (U27, board core/PaneAsk): the server's ask, read-only tools only.</summary>
    public interface IAskTools
    {
        Task<AskAnswer> AskAsync(string question, IReadOnlyList<(string Role, string Text)> history);
        Task<AskStatus> StatusAsync();
    }

    /// <summary>Sample values from board core/PaneAsk.</summary>
    public sealed class MockAskTools : IAskTools
    {
        public List<(string Question, int History)> Asked { get; } = new List<(string, int)>();
        public bool KeySaved { get; set; } = true;

        public Task<AskAnswer> AskAsync(string question, IReadOnlyList<(string Role, string Text)> history)
        {
            Asked.Add((question, history.Count));
            if (!KeySaved) return Task.FromResult(new AskAnswer { Text = "No Claude API key on this PC." });
            var a = new AskAnswer { Ok = true, Text = "21 sheets and 64 views (sample).", Model = "claude-sonnet-5-5", Tokens = 2140, BudgetLeft = 181580 };
            a.ToolsUsed.AddRange(new[] { "document_info", "model_statistics" });
            return Task.FromResult(a);
        }

        public Task<AskStatus> StatusAsync()
        {
            var s = new AskStatus { Ok = true, KeySaved = KeySaved, KeyFile = @"%APPDATA%\Formcraft\anthropic_api_key.txt", Model = "claude-sonnet-5-5", DailyTokens = 200000, UsedToday = 18420, QuestionsToday = 7 };
            s.Tools.AddRange(new[] { ("document_info", "The open Revit documents"), ("active_view", "The active view"), ("selected_elements", "Selected elements"),
                                     ("view_elements", "Elements in the view"), ("model_statistics", "Model statistics"), ("material_quantities", "Material quantities") });
            s.Log.Add(("2026-10-14T10:42:00Z", "model_statistics", 2140, "answered"));
            return Task.FromResult(s);
        }
    }
}
