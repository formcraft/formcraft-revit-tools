using System;
using System.Collections.Generic;
using System.Linq;
using RevitMCPCommandSet;
using Xunit;

public class FmcUndoPlanTests
{
    private sealed record E(string Id, string Kind, string Label);

    private static List<List<E>> Plan(IReadOnlyList<E> u, string batchId = "", int count = 1) =>
        FmcUndoPlan.Build(u, e => e.Id, e => e.Kind, e => e.Label, e => new DateTime(2026, 11, 28, 10, 0, 0), batchId, count, "M");

    private static string[] Ids(List<List<E>> plan) => plan.Select(c => c[0].Id).ToArray();

    // bottom first, as Revit's undo list grows
    private static readonly E[] List3 = { new("b1.1", "ai", "Walls"), new("b2.1", "ai", "Doors"), new("b2.2", "ai", "Tags"), new("b3.1", "ai", "Rooms") };

    [Fact]
    public void LastBatchByDefault() => Assert.Equal(new[] { "b3.1" }, Ids(Plan(List3)));

    [Fact]
    public void CountTakesWholeBatches() => Assert.Equal(new[] { "b3.1", "b2.2", "b2.1" }, Ids(Plan(List3, count: 2)));

    [Fact]
    public void DownToBatchId() => Assert.Equal(new[] { "b3.1", "b2.2" }, Ids(Plan(List3, batchId: "b2.2")));

    [Fact]
    public void SameIdIsOneCluster()
    {
        var u = new[] { new E("b1.1", "ai", "Walls"), new E("b1.1", "ai", "Walls (2)") };
        var plan = Plan(u);
        Assert.Single(plan);
        Assert.Equal(2, plan[0].Count);
    }

    [Fact]
    public void PersonOnTopRefuses()
    {
        var u = List3.Append(new E("x9", "other", "Move")).ToArray();
        var ex = Assert.Throws<InvalidOperationException>(() => Plan(u));
        Assert.Contains("never undoes a person's work", ex.Message);
        Assert.Contains("\"Move\"", ex.Message);
    }

    [Fact]
    public void PersonBetweenBatchesRefusesDeeperPlan()
    {
        var u = new[] { new E("b1.1", "ai", "Walls"), new E("x1", "other", "Wall edit"), new E("b2.1", "ai", "Doors") };
        Assert.Equal(new[] { "b2.1" }, Ids(Plan(u)));
        Assert.Throws<InvalidOperationException>(() => Plan(u, count: 2));
        Assert.Throws<InvalidOperationException>(() => Plan(u, batchId: "b1.1"));
    }

    [Fact]
    public void UnknownBatchRefuses()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => Plan(List3, batchId: "b99"));
        Assert.Contains("isn't on Revit's undo list for M", ex.Message);
    }

    [Fact]
    public void EmptyListRefuses() => Assert.Throws<InvalidOperationException>(() => Plan(Array.Empty<E>()));

    [Fact]
    public void BatchOfStripsTheStep() => Assert.Equal("b12", FmcUndoPlan.BatchOf("b12.3"));
}
