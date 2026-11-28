using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc;

// Exit code 0 when FmcPlacementCore agrees with every case in server/src/fmc/fixtures/placement_cases.json.
var fixture = JObject.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "placement_cases.json")));
int failed = 0, total = 0;
void Check(bool ok, string name)
{
    total++;
    if (ok) return;
    failed++;
    Console.WriteLine("FAIL " + name);
}

foreach (JObject c in fixture["labels"])
{
    var got = FmcPlacementCore.GridLabels(c.Value<int>("count"), c.Value<string>("start"), c.Value<string>("style"));
    var want = c["want"].Select(t => t.ToString()).ToList();
    Check(got.SequenceEqual(want), $"labels {c.Value<string>("start")}/{c.Value<string>("style")}: got {string.Join(",", got)}");
}
foreach (JObject c in fixture["duplicates"])
{
    var requested = c["requested"].Select(t => t.ToString()).ToList();
    var existing = c["existing"].Select(t => t.ToString()).ToList();
    var got = FmcPlacementCore.Duplicates(requested, existing).Select(p => p.Key + ":" + p.Value).ToList();
    var want = c["want"].Select(t => t[0].ToString() + ":" + t[1].ToString()).ToList();
    Check(got.SequenceEqual(want), $"duplicates {string.Join(",", requested)}: got {string.Join(",", got)}");
}
foreach (JObject c in fixture["unique"])
{
    var existing = new HashSet<string>(c["existing"].Select(t => t.ToString()));
    string got = FmcPlacementCore.UniqueName(c.Value<string>("base"), existing);
    Check(got == c.Value<string>("want"), $"unique {c.Value<string>("base")}: got {got}");
}
foreach (JObject c in fixture["blank"])
{
    string text = c["text"].Type == JTokenType.Null ? null : c.Value<string>("text");
    Check(FmcPlacementCore.IsBlankTagText(text) == c.Value<bool>("want"), $"blank '{text ?? "null"}'");
}
Check(FmcPlacementCore.SamePoint(0, 0, 0, 3, 4, 0, 5), "same point within 5 mm");
Check(!FmcPlacementCore.SamePoint(0, 0, 0, 3, 4, 0.1, 5), "not the same point past 5 mm");
var item = FmcPlacementCore.Item(2, "failed", null, "FMC-GRID-DUPLICATE", "exists", "A");
Check(item["index"].Equals(2) && (string)item["status"] == "failed" && !item.ContainsKey("id") && (string)item["code"] == "FMC-GRID-DUPLICATE", "item row");

Console.WriteLine($"{total - failed} passed, {failed} failed, {total} total");
return failed == 0 ? 0 : 1;
