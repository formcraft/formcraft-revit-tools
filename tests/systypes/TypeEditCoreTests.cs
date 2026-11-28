using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc.SystemTypes;
using Xunit;

namespace SystemTypes.Tests
{
    public class TypeEditCoreTests
    {
        private static List<TypeEditCore.LayerRow> Wall() => new List<TypeEditCore.LayerRow>
        {
            new TypeEditCore.LayerRow { Function = "Finish1", WidthMm = 15, MaterialId = 11 },
            new TypeEditCore.LayerRow { Function = "Structure", WidthMm = 200, MaterialId = 12 },
            new TypeEditCore.LayerRow { Function = "Finish2", WidthMm = 15, MaterialId = 13 },
        };

        private static bool AllOk(JArray items) => items.All(x => x.Value<bool>("ok"));

        [Fact]
        public void LayerEditInPlaceKeepsTheOtherLayersAndMaterials()
        {
            var items = new JArray();
            var op = JObject.Parse("{op:'edit_type', layer_edits:[{index:1, width_mm:250}]}");
            var plan = TypeEditCore.PlanLayers(Wall(), 1, 1, 1, op, items);
            Assert.True(plan.Ok); Assert.True(plan.Changed); Assert.True(AllOk(items));
            Assert.Equal(280, plan.TotalMm);
            Assert.Equal(12, plan.Layers[1].MaterialId);
            Assert.Null(plan.Layers[1].Material);
            Assert.Equal(1, plan.ExteriorShell);
            Assert.Equal(1, plan.StructuralIndex);
            Assert.Equal(200, items[0]["before"].Value<double>("width_mm"));
        }

        [Fact]
        public void ReplaceAllPicksTheFirstStructureLayerAndResetsAShellThatNoLongerFits()
        {
            var items = new JArray();
            var op = JObject.Parse("{layers:[{function:'Structure', width_mm:180, material:'Concrete'}]}");
            var plan = TypeEditCore.PlanLayers(Wall(), 1, 1, 1, op, items);
            Assert.True(plan.Ok);
            Assert.Single(plan.Layers);
            Assert.Equal(0, plan.StructuralIndex);
            Assert.Equal(0, plan.ExteriorShell + plan.InteriorShell);
            Assert.Contains(items, x => x.Value<string>("item") == "core" && x.Value<string>("reason").Contains("reset"));
        }

        [Fact]
        public void InsertAndRemoveUseTheIndexesAPersonWrote()
        {
            var items = new JArray();
            var op = JObject.Parse("{layer_edits:[{index:0, remove:true}, {insert_at:3, function:'Insulation', width_mm:50, material:'Mineral wool'}]}");
            var plan = TypeEditCore.PlanLayers(Wall(), 0, 0, 1, op, items);
            Assert.True(plan.Ok);
            Assert.Equal(new[] { "Structure", "Finish2", "Insulation" }, plan.Layers.Select(l => l.Function).ToArray());
            Assert.Equal(0, plan.StructuralIndex);
        }

        [Fact]
        public void BadLayerEditsAreRowsNotSilentSkips()
        {
            var items = new JArray();
            var op = JObject.Parse("{layer_edits:[{index:9, width_mm:10}, {index:0, function:'Paint'}, {index:1}], core:{exterior_shell_layers:2, interior_shell_layers:1}}");
            var plan = TypeEditCore.PlanLayers(Wall(), 0, 0, 1, op, items);
            Assert.False(plan.Ok);
            Assert.Equal(4, items.Count(x => !x.Value<bool>("ok")));
            Assert.All(items.Where(x => !x.Value<bool>("ok")), x => Assert.Equal(TypeEditCore.CodeBadValue, x.Value<string>("code")));
        }

        [Fact]
        public void MembraneIsZeroAndOtherLayersAreThick()
        {
            var items = new JArray();
            var op = JObject.Parse("{layers:[{function:'Membrane', width_mm:2}, {function:'Structure', width_mm:0}]}");
            var plan = TypeEditCore.PlanLayers(Wall(), 0, 0, 1, op, items);
            Assert.False(plan.Ok);
            Assert.Equal(2, items.Count(x => !x.Value<bool>("ok")));
        }

        [Fact]
        public void CoreBoundariesMustLeaveACore()
        {
            var ok = new JArray();
            Assert.True(TypeEditCore.PlanLayers(Wall(), 0, 0, 1, JObject.Parse("{core:{exterior_shell_layers:1, interior_shell_layers:1}}"), ok).Ok);
            var bad = new JArray();
            Assert.False(TypeEditCore.PlanLayers(Wall(), 0, 0, 1, JObject.Parse("{core:{exterior:2, interior:1}}"), bad).Ok);
        }

        [Fact]
        public void UnknownKeysAndWrongKindsAreRefusedByName()
        {
            var items = new JArray();
            var groups = TypeEditCore.RequestedGroups(JObject.Parse("{op:'edit_type', type:5, layer:[], stair:{}, _fmc:1}"), items);
            Assert.Equal(new[] { "stair" }, groups.ToArray());
            Assert.Single(items);
            Assert.Equal(TypeEditCore.CodeUnknownKey, items[0].Value<string>("code"));
            Assert.Null(TypeEditCore.WrongKind("layers", "CeilingType"));
            Assert.Null(TypeEditCore.WrongKind("layers", "RoofType"));
            Assert.NotNull(TypeEditCore.WrongKind("wrapping", "FloorType"));
            Assert.Contains("routing", TypeEditCore.WrongKind("fittings", "PipeType"));
            Assert.Contains("fmc_conduit", TypeEditCore.WrongKind("routing", "ConduitType"));
            Assert.Null(TypeEditCore.WrongKind("params", "AnythingType"));
        }

        [Fact]
        public void StairLimitsFollowRevitsRangeAndReadOnlyPropertiesAreNamed()
        {
            var items = new JArray(); bool ok = true;
            var v = TypeEditCore.PlanStairLengths("stair", JObject.Parse("{max_riser_mm:175, min_tread_mm:0, construction_method:'x', colour:1, run_type:'R1'}"),
                TypeEditCore.StairLengths, TypeEditCore.StairRefs.Keys, items, ref ok);
            Assert.False(ok);
            Assert.Equal(175, v["max_riser_mm"]);
            Assert.False(v.ContainsKey("min_tread_mm"));
            Assert.Contains(items, x => x.Value<string>("code") == TypeEditCore.CodeReadOnly);
            Assert.Contains(items, x => x.Value<string>("code") == TypeEditCore.CodeUnknownKey && x.Value<string>("item") == "stair.colour");
            Assert.DoesNotContain(items, x => x.Value<string>("item") == "stair.run_type");
        }

        [Fact]
        public void RoutingRulesParseAndRefuseGroupsTheTypeHasNot()
        {
            var adds = new List<TypeEditCore.RuleRow>(); var removes = new List<TypeEditCore.RuleRemoval>();
            var items = new JArray(); bool ok = true;
            TypeEditCore.ParseRouting(JObject.Parse("{add:[{group:'elbows', part:'Elbow : Standard', min_mm:15, max_mm:100}, {group:'segments', part:'PVC'}], remove:[{group:'unions', index:0}], preferred_junction:'tap'}"),
                "DuctType", adds, removes, out string junction, items, ref ok);
            Assert.False(ok);
            Assert.Single(adds);
            Assert.Equal("Elbows", adds[0].Group);
            Assert.Single(removes);
            Assert.Equal("Tap", junction);
            Assert.Contains(items, x => x.Value<string>("code") == TypeEditCore.CodeWrongKind);

            adds.Clear(); removes.Clear(); items = new JArray(); ok = true;
            TypeEditCore.ParseRouting(JObject.Parse("{add:[{group:'segments', part:'PVC', min_mm:50, max_mm:20}]}"), "PipeType", adds, removes, out junction, items, ref ok);
            Assert.False(ok); Assert.Empty(adds);
        }

        [Fact]
        public void TheSameRuleIsNotAddedTwice()
        {
            Assert.True(TypeEditCore.SameRule("Elbows", 7, 15, 100, "Elbows", 7, 15.01, 100));
            Assert.False(TypeEditCore.SameRule("Elbows", 7, 15, 100, "Elbows", 7, 20, 100));
            Assert.False(TypeEditCore.SameRule("Elbows", 7, null, null, "Unions", 7, null, null));
        }

        [Fact]
        public void SegmentSizesRefuseDuplicatesAndBadDiameters()
        {
            var adds = new List<TypeEditCore.SizeRow>(); var removes = new List<double>();
            var items = new JArray(); bool ok = true;
            TypeEditCore.ParseSegmentSizes(JObject.Parse("{add:[{nominal_mm:25, id_mm:26, od_mm:32}, {nominal_mm:40, id_mm:41, od_mm:48}, {nominal_mm:50, id_mm:60, od_mm:55}], remove:[15, 999]}"),
                new List<double> { 15, 20, 25 }, adds, removes, items, ref ok);
            Assert.False(ok);
            Assert.Single(adds); Assert.Equal(40, adds[0].NominalMm);
            Assert.Equal(new[] { 15.0 }, removes.ToArray());
            Assert.Contains(items, x => x.Value<string>("code") == TypeEditCore.CodeSizeExists);
        }

        private static readonly List<TypeEditCore.TypeCandidate> Walls = new List<TypeEditCore.TypeCandidate>
        {
            new TypeEditCore.TypeCandidate { Id = 1, Name = "Generic 200", WidthMm = 200 },
            new TypeEditCore.TypeCandidate { Id = 2, Name = "Generic 300", WidthMm = 300 },
            new TypeEditCore.TypeCandidate { Id = 3, Name = "Block 300", WidthMm = 300.2 },
        };

        [Fact]
        public void PickNeverFallsBackToTheFirstType()
        {
            var missing = TypeEditCore.PickType("OST_Walls", 99, false, false, 200, true, Walls);
            Assert.False(missing.Ok); Assert.Equal(TypeEditCore.CodeTypeNotFound, missing.Code);
            var wrong = TypeEditCore.PickType("OST_Walls", 99, true, false, 200, true, Walls);
            Assert.False(wrong.Ok);
            var given = TypeEditCore.PickType("OST_Walls", 2, true, true, 300, true, Walls);
            Assert.Equal(2, given.Id);
        }

        [Fact]
        public void ThicknessPicksTheOneMatchingTypeOrRefuses()
        {
            Assert.Equal(1, TypeEditCore.PickType("OST_Walls", -1, false, false, 200, true, Walls).Id);
            Assert.Equal(TypeEditCore.CodeAmbiguous, TypeEditCore.PickType("OST_Walls", -1, false, false, 300, true, Walls).Code);
            Assert.Equal(TypeEditCore.CodeNoThicknessMatch, TypeEditCore.PickType("OST_Walls", 0, false, false, 250, true, Walls).Code);
            Assert.Equal(TypeEditCore.CodeThicknessMismatch, TypeEditCore.PickType("OST_Walls", 1, true, true, 250, true, Walls).Code);
        }

        [Fact]
        public void TypesWithoutLayersNeedTheirTypeId()
        {
            var ducts = new List<TypeEditCore.TypeCandidate> { new TypeEditCore.TypeCandidate { Id = 8, Name = "Rect" } };
            Assert.Equal(TypeEditCore.CodeTypeRequired, TypeEditCore.PickType("OST_DuctCurves", -1, false, false, 200, false, ducts).Code);
            var given = TypeEditCore.PickType("OST_DuctCurves", 8, true, true, 200, false, ducts);
            Assert.Equal(8, given.Id);
            Assert.Contains("doesn't apply", given.Note);
        }
    }
}
