using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using RevitMCPCommandSet.Services.Fmc.Filter;
using Xunit;

namespace FilterCore.Tests
{
    public class CriteriaTests
    {
        private static JObject J(string s) => JObject.Parse(s);

        [Fact]
        public void Not_is_pushed_down_with_de_morgan()
        {
            var n = Criteria.Normalize(J("{\"not\":{\"all\":[{\"category\":\"OST_Walls\"},{\"any\":[{\"level\":\"L1\"},{\"level\":\"L2\"}]}]}}"));
            Assert.Equal(Node.NodeKind.Any, n.Kind);
            Assert.True(n.Children[0].Negate);
            Assert.Equal("category", n.Children[0].LeafKind);
            Assert.Equal(Node.NodeKind.All, n.Children[1].Kind);   // not(any) = all(not)
            Assert.All(n.Children[1].Children, c => Assert.True(c.Negate));
        }

        [Fact]
        public void Double_not_cancels_and_nested_all_flattens()
        {
            var n = Criteria.Normalize(J("{\"all\":[{\"not\":{\"not\":{\"category\":\"OST_Doors\"}}},{\"all\":[{\"level\":\"L1\"},{\"family\":\"X\"}]}]}"));
            Assert.Equal(Node.NodeKind.All, n.Kind);
            Assert.Equal(3, n.Children.Count);
            Assert.False(n.Children[0].Negate);
        }

        [Fact]
        public void Limits_refuse_depth_7_and_65_leaves_and_empty_or()
        {
            JObject deep = J("{\"category\":\"OST_Walls\"}");
            for (int i = 0; i < 6; i++) deep = new JObject { ["not"] = deep };   // depth 7
            Assert.Equal("FMC-FILTER-BAD-CRITERIA", Assert.Throws<FilterException>(() => Criteria.Validate(deep)).Code);
            JObject ok = J("{\"category\":\"OST_Walls\"}");
            for (int i = 0; i < 5; i++) ok = new JObject { ["not"] = ok };      // depth 6
            Criteria.Validate(ok);
            var many = new JObject { ["all"] = new JArray(Enumerable.Range(0, 65).Select(i => new JObject { ["mark"] = "x", ["param"] = "Mark", ["op"] = "=", ["value"] = i })) };
            Assert.Throws<FilterException>(() => Criteria.Validate(many));
            Assert.Throws<FilterException>(() => Criteria.Validate(J("{\"any\":[]}")));
            var wide = new JObject { ["any"] = new JArray(Enumerable.Range(0, 17).Select(i => new JObject { ["level"] = "L" + i })) };
            Assert.Throws<FilterException>(() => Criteria.Validate(wide));
        }

        [Fact]
        public void Bad_leaves_and_ops_are_refused_with_codes()
        {
            Assert.Throws<FilterException>(() => Criteria.Validate(J("{\"colour\":\"red\"}")));
            Assert.Throws<FilterException>(() => Criteria.Validate(J("{\"param\":\"Height\",\"op\":\"~\",\"value\":1}")));
            Assert.Throws<FilterException>(() => Criteria.Validate(J("{\"param\":\"Height\",\"op\":\">\"}")));
            Assert.Throws<FilterException>(() => Criteria.Validate(J("{\"param\":\"Width\",\"op\":\"between\",\"value\":[1]}")));
            Assert.Equal("FMC-FILTER-UNIT", Assert.Throws<FilterException>(() => Criteria.Validate(J("{\"param\":\"Height\",\"op\":\">\",\"value\":2,\"unit\":\"furlong\"}"))).Code);
            var cats = new JObject { ["category"] = new JArray(Enumerable.Range(0, 201).Select(i => "c" + i)) };
            Assert.Throws<FilterException>(() => Criteria.Validate(cats));
            Assert.Equal("FMC-FILTER-BOUNDARY-INVALID", Assert.Throws<FilterException>(() => Criteria.Validate(J("{\"in_boundary\":{\"polygon_mm\":[[0,0],[1,1]]}}"))).Code);
            Criteria.Validate(J("{\"param\":\"Fire Rating\",\"op\":\"empty\"}"));
            Criteria.Validate(J("{\"in_room\":{\"room\":\"2.14\",\"mode\":\"center\"}}"));
        }

        [Fact]
        public void Narrowing_and_top_categories()
        {
            Assert.False(Criteria.IsNarrowed(Criteria.Normalize(J("{\"param\":\"Height\",\"op\":\">\",\"value\":2}"))));
            Assert.True(Criteria.IsNarrowed(Criteria.Normalize(J("{\"all\":[{\"category\":\"OST_Doors\"},{\"param\":\"Height\",\"op\":\">\",\"value\":2}]}"))));
            Assert.False(Criteria.IsNarrowed(Criteria.Normalize(J("{\"not\":{\"category\":\"OST_Walls\"}}"))));
            Assert.False(Criteria.IsNarrowed(Criteria.Normalize(J("{\"any\":[{\"category\":\"OST_Doors\"},{\"level\":\"L1\"}]}"))));
            var cats = Criteria.TopCategories(Criteria.Normalize(J("{\"all\":[{\"category\":\"OST_Rooms\"},{\"level\":\"Level 1\"}]}")));
            Assert.Single(cats);
        }

        [Fact]
        public void Flat_select_by_keys_become_one_all_node()
        {
            var tree = Criteria.FromFlat(J("{\"category\":[\"Walls\"],\"level\":\"L2\",\"type_name\":\"200\",\"mark\":\"W1\",\"param\":[{\"name\":\"Mark\",\"is\":\"empty\"},{\"name\":\"Height\",\"is\":\"gt\",\"value\":3000}],\"exclude\":[5],\"room\":\"2.14\",\"box_mm\":[[0,0],[1000,1000]]}"));
            var all = (JArray)tree["all"];
            Assert.Contains(all, x => x["category"] != null);
            Assert.Contains(all, x => x.Value<string>("type") == "200" && x.Value<string>("match") == "contains");
            Assert.Contains(all, x => x.Value<string>("bip") == "ALL_MODEL_MARK");
            Assert.Contains(all, x => x.Value<string>("param") == "Height" && x.Value<string>("op") == ">");
            Assert.Contains(all, x => x.Value<string>("param") == "Mark" && x.Value<string>("op") == "empty");
            Assert.Contains(all, x => x["not"]?["ids"] != null);
            Assert.Contains(all, x => x["in_room"] != null);
            Assert.Contains(all, x => x["in_box"] != null);
            Criteria.Validate(tree);
            Assert.Null(Criteria.FromFlat(new JObject()));
            Assert.Equal("OST_Doors", Criteria.FromFlat(J("{\"category\":\"OST_Doors\"}")).Value<string>("category"));
        }
    }

    public class TriTests
    {
        private static Func<Tri> F(Tri t) => () => t;
        private static readonly Tri U = Tri.Unknown("PARAM_MISSING", "Fire Rating");

        [Fact]
        public void And_or_not_three_valued()
        {
            Assert.True(Tri.And(new[] { F(Tri.T), F(Tri.T) }).IsTrue);
            Assert.True(Tri.And(new[] { F(U), F(Tri.F) }).IsFalse);   // false wins over unknown
            Assert.True(Tri.And(new[] { F(Tri.T), F(U) }).IsUnknown);
            Assert.True(Tri.Or(new[] { F(U), F(Tri.T) }).IsTrue);     // true wins over unknown
            Assert.True(Tri.Or(new[] { F(Tri.F), F(U) }).IsUnknown);
            Assert.True(Tri.Or(new[] { F(Tri.F), F(Tri.F) }).IsFalse);
            Assert.True(U.Not().IsUnknown);                          // NOT of unknown stays unknown
            Assert.Equal("Fire Rating", U.Not().Detail);
            Assert.True(Tri.T.Not().IsFalse);
        }

        [Fact]
        public void Missing_setting_resolves_param_unknowns_only()
        {
            Assert.True(U.Resolve("report").IsUnknown);
            Assert.True(U.Resolve("no_match").IsFalse);
            Assert.True(U.Resolve("match").IsTrue);
            var room = Tri.Unknown("ROOM_TEST_FAILED");
            Assert.True(room.Resolve("no_match").IsUnknown);   // a failed test is never guessed
            Assert.True(Tri.IsUndeterminedReason("PARAM_UNREADABLE"));
            Assert.False(Tri.IsUndeterminedReason("NO_LOCATION"));
        }

        [Fact]
        public void And_short_circuits_on_false()
        {
            int calls = 0;
            Tri.And(new Func<Tri>[] { () => { calls++; return Tri.F; }, () => { calls++; return Tri.T; } });
            Assert.Equal(1, calls);
        }

        [Fact]
        public void Invert_never_turns_unknown_into_a_match()
        {
            // invert: universe true and tree false is a match; tree unknown stays undetermined
            Tri Inv(Tri u, Tri m) => u.IsUnknown ? u : m.IsUnknown ? m : Tri.Of(m.IsFalse);
            Assert.True(Inv(Tri.T, Tri.F).IsTrue);
            Assert.True(Inv(Tri.T, Tri.T).IsFalse);
            Assert.True(Inv(Tri.T, U).IsUnknown);
        }
    }

    public class UnitsTests
    {
        [Fact]
        public void Lengths_areas_volumes_angles()
        {
            Assert.Equal(6.5617, Units.ToInternal(2000, Units.Spec.Length, null), 4);
            Assert.Equal(6.5617, Units.ToInternal(2, Units.Spec.Length, "m"), 4);
            Assert.Equal(10.7639, Units.ToInternal(1, Units.Spec.Area, null), 4);      // 1 m² in ft²
            Assert.Equal(35.3147, Units.ToInternal(1, Units.Spec.Volume, "m3"), 4);
            Assert.Equal(Math.PI / 2, Units.ToInternal(90, Units.Spec.Angle, null), 9);
            Assert.Equal(7.5, Units.ToInternal(7.5, Units.Spec.Other, null));
            Assert.Equal(2000.0, Units.FromInternal(6.561679790026247, Units.Spec.Length));
            Assert.Equal(12.5, Units.FromInternal(12.5 * 10.7639104, Units.Spec.Area), 3);
            Assert.Equal("FMC-FILTER-UNIT", Assert.Throws<FilterException>(() => Units.ToInternal(1, Units.Spec.Length, "m2")).Code);
            Assert.Equal("m²", Units.Label(Units.Spec.Area));
        }
    }

    public class CompareTests
    {
        private static double Mm(double v) => Units.ToInternal(v, Units.Spec.Length, null);
        private static readonly double Tol = Units.Tolerance(Units.Spec.Length, 0);

        [Fact]
        public void Numbers_with_length_tolerance()
        {
            double h = Mm(2100);
            Assert.True(Compare.Number(">", h, 2000, Mm, Tol));
            Assert.False(Compare.Number(">", Mm(2000.3), 2000, Mm, Tol));   // within 0.5 mm is equal, not greater
            Assert.True(Compare.Number("=", Mm(2000.3), 2000, Mm, Tol));
            Assert.True(Compare.Number(">=", Mm(1999.8), 2000, Mm, Tol));
            Assert.True(Compare.Number("!=", h, 2000, Mm, Tol));
            Assert.True(Compare.Number("between", Mm(900), new JArray(1000, 800), Mm, Tol));
            Assert.False(Compare.Number("between", Mm(1001), new JArray(800, 1000), Mm, Tol));
            Assert.True(Compare.Number("in", Mm(900), new JArray(800, 900), Mm, Tol));
            Assert.True(Compare.Number("<", 5, "6", x => x, -1));
        }

        [Fact]
        public void Text_ops_are_case_insensitive()
        {
            Assert.True(Compare.Text("=", "Exterior", "exterior"));
            Assert.True(Compare.Text("contains", "Toilet WC 2", "wc"));
            Assert.True(Compare.Text("starts", "FMC_Door_Single", "fmc_"));
            Assert.True(Compare.Text("ends", "900x2100", "2100"));
            Assert.True(Compare.Text("in", "60", new JArray("60", "90")));
            Assert.False(Compare.Text("in", "120", new JArray("60", "90")));
            Assert.True(Compare.Text("!=", "a", "b"));
            Assert.True(Compare.Name("FMC_Door_Single", new JArray("x", "fmc_door_single"), "equals"));
            Assert.Equal(1, Compare.YesNo("Yes"));
            Assert.Equal(0, Compare.YesNo(false));
            Assert.Null(Compare.YesNo("maybe"));
            Assert.True(Compare.IsNumber("2.5"));
            Assert.False(Compare.IsNumber("Exterior"));
        }
    }

    public class PolygonTests
    {
        private static List<(double, double)> P(params double[] xy) => Enumerable.Range(0, xy.Length / 2).Select(i => (xy[2 * i], xy[(2 * i) + 1])).ToList();

        [Fact]
        public void Concave_polygon_even_odd()
        {
            var l = P(0, 0, 10, 0, 10, 10, 5, 10, 5, 5, 0, 5);   // an L
            Assert.Null(Polygon.Problem(l));
            Assert.True(Polygon.Contains(l, 2, 2));
            Assert.True(Polygon.Contains(l, 8, 8));
            Assert.False(Polygon.Contains(l, 2, 8));            // the notch
            Assert.False(Polygon.Contains(l, 11, 1));
        }

        [Fact]
        public void On_edge_counts_inside()
        {
            var sq = P(0, 0, 10, 0, 10, 10, 0, 10);
            Assert.True(Polygon.Contains(sq, 10, 5));
            Assert.True(Polygon.Contains(sq, 0, 0));
        }

        [Fact]
        public void Self_intersection_zero_area_and_size_refused()
        {
            Assert.NotNull(Polygon.Problem(P(0, 0, 10, 10, 10, 0, 0, 10)));   // a bow tie
            Assert.NotNull(Polygon.Problem(P(0, 0, 5, 0, 10, 0)));            // zero area
            Assert.NotNull(Polygon.Problem(P(0, 0, 1, 1)));
            var big = Enumerable.Range(0, 501).Select(i => (Math.Cos(i * 2 * Math.PI / 501), Math.Sin(i * 2 * Math.PI / 501))).ToList();
            Assert.Contains("at most", Polygon.Problem(big));
            var closed = Polygon.Read(JArray.Parse("[[0,0],[10,0],[10,10],[0,0]]"));
            Assert.Equal(3, closed.Count);   // a repeated first point is dropped
            Assert.Equal(50, Polygon.Area(closed), 6);
        }
    }

    public class CursorAndSnapshotTests
    {
        [Fact]
        public void Cursor_round_trip_and_tamper()
        {
            var c = new Cursor { Rs = "rs_0123456789ab", D = 1, L = 556677, A = 314159, V = "v1", H = "q_2c81e0aaaaaa" };
            string tok = c.Encode();
            Assert.StartsWith("c1.", tok);
            Assert.DoesNotContain("=", tok);
            var back = Cursor.Decode(tok);
            Assert.Equal(c.Rs, back.Rs); Assert.Equal(1, back.D); Assert.Equal(556677, back.L); Assert.Equal(314159, back.A); Assert.Equal(c.H, back.H);
            Assert.Equal("FMC-FILTER-CURSOR-INVALID", Assert.Throws<FilterException>(() => Cursor.Decode("c1.!!!notbase64")).Code);
            Assert.Throws<FilterException>(() => Cursor.Decode("c2." + tok.Substring(3)));
            Assert.Throws<FilterException>(() => Cursor.Decode("c1.eyJycyI6IngifQ"));   // {"rs":"x"}: no hash
        }

        [Fact]
        public void Query_hash_is_stable_and_order_free()
        {
            var a = Hashes.QueryOf(JObject.Parse("{\"all\":[{\"category\":\"OST_Doors\"},{\"level\":\"L2\"}]}"), JObject.Parse("{\"links\":\"both\",\"documents\":\"target\"}"), false, "report", "instances");
            var b = Hashes.QueryOf(JObject.Parse("{\"all\":[{\"category\":\"OST_Doors\"},{\"level\":\"L2\"}]}"), JObject.Parse("{\"documents\":\"target\",\"links\":\"both\"}"), false, "report", "instances");
            var c = Hashes.QueryOf(JObject.Parse("{\"all\":[{\"category\":\"OST_Doors\"},{\"level\":\"L3\"}]}"), JObject.Parse("{\"documents\":\"target\",\"links\":\"both\"}"), false, "report", "instances");
            Assert.Equal(Hashes.Query(a), Hashes.Query(b));
            Assert.NotEqual(Hashes.Query(a), Hashes.Query(c));
            Assert.StartsWith("q_", Hashes.Query(a));
            Assert.Equal(14, Hashes.Query(a).Length);
        }

        [Fact]
        public void Version_vector_changes_are_found()
        {
            var then = new Dictionary<string, string> { ["A"] = "g.1.4", ["link:5:A"] = "h.0.0" };
            Assert.Empty(Hashes.Changed(then, new Dictionary<string, string>(then)));
            Assert.Equal(new[] { "A" }, Hashes.Changed(then, new Dictionary<string, string> { ["A"] = "g.1.5", ["link:5:A"] = "h.0.0" }));
            Assert.Equal(new[] { "link:5:A" }, Hashes.Changed(then, new Dictionary<string, string> { ["A"] = "g.1.4" }));   // closed = changed
            Assert.NotEqual(Hashes.Versions(then), Hashes.Versions(new Dictionary<string, string> { ["A"] = "g.1.5" }));
        }

        [Fact]
        public void Snapshot_after_is_stable_by_group_link_id()
        {
            var s = new Snapshot();
            s.Entries.AddRange(new[] { new SnapEntry(1, 7, 3), new SnapEntry(0, 0, 9), new SnapEntry(0, 0, 2), new SnapEntry(1, 7, 1) });
            s.Entries.Sort();
            Assert.Equal(new long[] { 2, 9, 1, 3 }, s.Entries.Select(e => e.Id).ToArray());
            Assert.Equal(0, s.After(-1, 0, 0));
            Assert.Equal(1, s.After(0, 0, 2));
            Assert.Equal(2, s.After(0, 0, 9));
            Assert.Equal(1, s.After(0, 0, 5));   // an id deleted since: resumes after it by order
            Assert.Equal(4, s.After(1, 7, 3));
        }

        [Fact]
        public void Cache_is_lru_with_idle_ttl_and_drops_closed_documents()
        {
            var now = new DateTime(2026, 11, 28, 7, 0, 0, DateTimeKind.Utc);
            var cache = new SnapshotCache(max: 3, idle: TimeSpan.FromMinutes(15)) { Now = () => now };
            for (int i = 0; i < 3; i++) cache.Put(new Snapshot { Id = "rs_" + i, DocKeys = { "D" + i } });
            Assert.NotNull(cache.Get("rs_0"));          // touched: now the newest
            cache.Put(new Snapshot { Id = "rs_3", DocKeys = { "D3" } });
            Assert.Null(cache.Get("rs_1"));             // least recently used went
            Assert.NotNull(cache.Get("rs_0"));
            Assert.Equal(1, cache.DropDocument("D0"));
            Assert.Null(cache.Get("rs_0"));
            now = now.AddMinutes(16);
            Assert.Null(cache.Get("rs_3"));             // idle past 15 minutes
            Assert.Equal(0, cache.Count);
            Assert.Matches("^rs_[0-9a-f]{12}$", SnapshotCache.NewId());
        }
    }

    public class ByteCapAndKeyParamsTests
    {
        [Fact]
        public void Small_page_untouched_big_page_cut_then_dropped()
        {
            var rows = new JArray(new JObject { ["id"] = 1, ["name"] = "a", ["params"] = new JObject { ["Mark"] = "x" } });
            Assert.False(ByteCap.Apply(rows).truncated);
            var big = new JArray(Enumerable.Range(0, 100).Select(i => new JObject
            {
                ["id"] = i, ["name"] = "n" + i, ["category"] = "Doors", ["doc"] = "A", ["link"] = null, ["family"] = "F",
                ["params"] = new JObject { ["Comments"] = new string('c', 3000), ["Notes"] = new string('n', 3000) },
            }));
            var (truncated, dropped) = ByteCap.Apply(big, 64 * 1024);
            Assert.True(truncated);
            Assert.True(ByteCap.Size(big) <= 64 * 1024);
            Assert.All(big, r => Assert.NotNull(r["id"]));
            Assert.All(big, r => Assert.NotNull(r["name"]));
            Assert.Equal(201, big[0]["params"]["Comments"].ToString().Length);   // 200 + ellipsis
            var huge = new JArray(Enumerable.Range(0, 300).Select(i => new JObject
            {
                ["id"] = i, ["name"] = "n", ["category"] = "c", ["doc"] = "d", ["link"] = null,
                ["params"] = new JObject(Enumerable.Range(0, 40).Select(k => new JProperty("P" + k, new string('v', 150)))),
            }));
            (truncated, dropped) = ByteCap.Apply(huge, 256 * 1024);
            Assert.True(truncated);
            Assert.NotEmpty(dropped);
            Assert.True(ByteCap.Size(huge) <= 256 * 1024);
        }

        [Fact]
        public void Key_params_kit_first_then_builtin()
        {
            var (walls, src) = KeyParams.For("OST_Walls", null);
            Assert.Equal("built-in default", src);
            Assert.Contains("Function", walls);
            var kit = JObject.Parse("{\"Doors\":[\"Mark\",\"FMC_DoorCode\"]}");
            var (doors, src2) = KeyParams.For("OST_Doors", kit);
            Assert.Equal("kit", src2);
            Assert.Contains("FMC_DoorCode", doors);
            Assert.Equal(new[] { "Mark", "Comments", "Type Mark" }, KeyParams.For("OST_Furniture", null).names);
            Assert.Contains("Area", KeyParams.For("OST_Rooms", null).names);
        }

        [Fact]
        public void Limits_page_size_and_scan_cap()
        {
            Assert.Equal(100, FilterLimits.PageSize(null));
            Assert.Equal(500, FilterLimits.PageSize(500));
            Assert.Throws<FilterException>(() => FilterLimits.PageSize(501));
            Assert.Throws<FilterException>(() => FilterLimits.PageSize(0));
            Assert.Equal(20000, FilterLimits.ScanCap(null));
            Assert.Equal(1000, FilterLimits.ScanCap(5));
            Assert.Equal(200000, FilterLimits.ScanCap(9999999));
            Assert.Equal(50000, FilterLimits.SnapshotMax);
            Assert.Equal(5000, FilterLimits.ShowMax);
            Assert.Equal(100000, FilterLimits.ExportRows);
        }

        [Fact]
        public void Filter_exception_json_keeps_its_code()
        {
            var fx = new FilterException("FMC-FILTER-TOO-BROAD", "too many", "narrow it", new JObject { ["ok"] = true, ["total"] = 60000 });
            var j = fx.ToJson();
            Assert.False(j.Value<bool>("ok"));
            Assert.Equal("FMC-FILTER-TOO-BROAD", j.Value<string>("code"));
            Assert.Equal(60000, j.Value<int>("total"));
            Assert.StartsWith("[FMC-FILTER-TOO-BROAD]", j.Value<string>("message"));
        }
    }
}
