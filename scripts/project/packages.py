# Discipline packages for the project report (docs/PROJECT_REPORT.md). One JSON per discipline in <report dir>/packages:
#   {discipline, label, status: designed|in_progress|not_started, summary, key: [[value, label]], model: {boxes, prisms,
#    lines, color}, quantities: [{item, qty, unit, rate: [low, likely, high], rate_mat: (materials only), group}], checks: [[text, done|partial|not]],
#    drawings: [image paths], notes: [..]}
# boxes: [x0,y0,z0, x1,y1,z1, b, h] (a member from point to point, b x h section, mm); prisms: [[loop xy...], z0, z1];
# lines: [[x,y,z],[x,y,z]]. This script writes architecture and structure from their data, and allowance packages
# for disciplines not designed yet (their own exporters replace them once the models exist).
#   python -I scripts/project/packages.py <project 01_WIP> <report dir>
import json, sys, os, math, collections
WIP, RD = sys.argv[1], sys.argv[2]
SW = WIP + "/_Structure/_work"
J = lambda p: json.load(open(p, encoding="utf-8"))
os.makedirs(RD + "/packages", exist_ok=True)
facts = J(SW + "/facts.json"); EL = {l["name"]: l["elevation_mm"] for l in facts["levels"]}
# rates: the project's own overrides (<report dir>/rates.json), else the kit's computed rates (FMC_Rates.json from the
# price book, scripts/cost/rates.py), else the fallback written here (marked so it can be found and replaced)
rates = J(RD + "/rates.json") if os.path.exists(RD + "/rates.json") else {}
KIT_MAT = (J(RD + "/report.json").get("kit_materials") if os.path.exists(RD + "/report.json") else None) or "D:/Fomcraft/FMC_BIM_27/FMC_Kit_v2.2/FMC_Kit_v2.2/07_Materials"
KR = {k: v for k, v in (J(KIT_MAT + "/FMC_Rates.json") if os.path.exists(KIT_MAT + "/FMC_Rates.json") else {}).items() if not k.startswith("_")}
FALLBACK = set()
def R(key, dflt):
    if key in rates: return tuple(rates[key])
    if key in KR: return tuple(KR[key]["rate"])
    FALLBACK.add(key); return tuple(dflt)
def RM(key, dflt):   # materials only (FMC_Rates.json rate_materials); project overrides and fallbacks take 75% of the full rate
    if key in rates: return tuple(round(x * 0.75, 4) for x in rates[key])
    if key in KR and "rate_materials" in KR[key]: return tuple(KR[key]["rate_materials"])
    return tuple(round(x * 0.75, 4) for x in dflt)
def RP(key, part, dflt, share):   # labour or plant part of a rate (kit), else the remainder of the full rate by share
    if key in KR and f"rate_{part}" in KR[key]: return tuple(KR[key][f"rate_{part}"])
    full, m = R(key, dflt), RM(key, dflt)
    return tuple(round((f - mm) * share, 4) for f, mm in zip(full, m))
def RR(key, dflt): return {"rate": list(R(key, dflt)), "rate_mat": list(RM(key, dflt)), "rate_lab": list(RP(key, "labour", dflt, 1)), "rate_plant": list(RP(key, "plant", dflt, 0))}
area = lambda lp: abs(sum(lp[i][0] * lp[(i + 1) % len(lp)][1] - lp[(i + 1) % len(lp)][0] * lp[i][1] for i in range(len(lp)))) / 2e6
PARTS = ["Main house", "Boys' quarters", "Site & external works"]
# shares of each allowance (assumed until the discipline is designed); optional items can be switched off by the client
SPLIT = {
 "plumbing": [("Cold water supply, storage tanks and fittings", .30, False), ("Sanitary fittings (WCs, basins, showers, sinks)", .25, False), ("Soil, waste and drainage to septic tank and soakaway", .25, False),
              ("Hot water (heaters and pipework)", .10, False), ("Rainwater harvesting tank and pump", .10, True)],
 "electrical": [("Power and lighting installation", .55, False), ("Distribution boards, earthing and lightning protection", .15, False), ("Light fittings (decorative)", .10, True),
                ("Solar PV and battery backup", .12, True), ("Data and CCTV cabling", .08, True)],
 "mechanical": [("Extract fans to kitchen and wet rooms", .15, False), ("Air conditioning (split units)", .55, True), ("Solar hot water system", .30, True)],
 "interiors": [("Kitchen units and worktops", .30, False), ("Built-in wardrobes", .22, False), ("Vanity units and bathroom joinery", .10, False), ("Shelving, TV units, feature joinery", .08, True),
               ("Loose furniture and soft furnishing", .30, True)],
 "fire": [("Smoke and heat detectors", .20, False), ("Fire extinguishers and blankets", .10, False), ("Intruder alarm", .20, True), ("CCTV cameras and recorder", .35, True), ("Access control and intercom", .15, True)],
 "landscape": [("Soft landscape and planting", .50, False), ("Irrigation", .25, True), ("Outdoor and garden lighting", .25, True)],
}
def split(disc, line):
    out = []
    for i, (lab, f, opt) in enumerate(SPLIT.get(disc, [])):
        out.append({"item": lab, "qty": line["qty"], "unit": line["unit"], **{k: [round(x * f, 4) for x in line[k]] for k in ("rate", "rate_mat", "rate_lab", "rate_plant") if k in line},
                    "group": "Allowance", "optional": opt})
    return out or [line]
def save(p): json.dump(p, open(f"{RD}/packages/{p['discipline']}.json", "w", encoding="utf-8"), separators=(",", ":"))

# ---------------- architecture (from the architecture model's facts) ----------------
boxes, prisms, lines = [], [], []
wq = collections.Counter(); op_area = 0
for w in facts["walls"]:
    z0 = EL.get(w["base_level"], 0) + (w.get("base_offset_mm") or 0); z1 = z0 + w["height_mm"]
    boxes.append([w["start_mm"][0], w["start_mm"][1], z0, w["end_mm"][0], w["end_mm"][1], z0, w["thickness_mm"], w["height_mm"]])
    if "Planter wall stone" in w["type"] and w["base_level"].startswith("Site") and w["length_mm"] > 15000: continue   # site boundary: costed under external works
    t = w["type"]; key = ("stone" if "stone" in t.lower() else "brick" if "brick" in t.lower() else "timber" if "Mvule" in t or "timber" in t.lower() else "block")
    wq[key] += max(0, w["length_mm"] * w["height_mm"] / 1e6 - (w.get("openings_area_m2") or 0)); op_area += w.get("openings_area_m2") or 0
fq = collections.Counter()
for fl in facts["floors"]:
    if not fl.get("outline_mm"): continue
    z = EL.get(fl["level"], 0) + (fl.get("offset_mm") or 0); lp = [[p[0], p[1]] for p in fl["outline_mm"][0]]
    prisms.append([lp, z - fl["thickness_mm"], z])
    t = fl["type"].lower(); key = ("external paving" if "ext" in t and any(k in t for k in ("paver", "sett", "stone", "pebble", "deck")) else "landscape" if any(k in t for k in ("topsoil", "mulch", "pebble")) else
                                   "timber floor" if any(k in t for k in ("oak", "deck", "plywood", "walkway")) else "rug" if "rug" in t else "tiled / stone floor" if any(k in t for k in ("porcelain", "travertine", "basalt", "terrazzo", "tile")) else "screed / other")
    if "slab" in t and "fin" not in t: continue   # the structural slab is the structure's
    fq[key] += fl["area_m2"]
roof_area = 0; roofs3d = []
for r in facts["roofs"]:
    if not r.get("plan_min_mm"): continue
    (x0, y0, z0), (x1, y1, z1) = r["plan_min_mm"], r["plan_max_mm"]; zb = EL.get(r["level"], z0); zb = max(zb, z0 if z0 > zb else zb)
    roofs3d.append([x0, y0, x1, y1, z0, z1]); roof_area += r["area_m2"]
gfa = sum(rm["area_m2"] for rm in facts["rooms"])
arch = {"discipline": "architecture", "label": "Architecture", "status": "designed",
  "summary": f"{len(facts['rooms'])} rooms, {gfa:,.0f} m² of rooms over {len({r['level'] for r in facts['rooms']})} levels; stone, brick and block walls; clay-tile timber roofs.",
  "key": [[f"{gfa:,.0f} m²", "room area"], [f"{len(facts['rooms'])}", "rooms"], [f"{op_area:,.0f} m²", "windows & doors"], [f"{roof_area:,.0f} m²", "roof"]],
  "model": {"mesh": "mesh/architecture.web.json"} if os.path.exists(RD + "/mesh/architecture.web.json") else {"boxes": boxes, "prisms": prisms, "roofs": roofs3d, "color": "#c8bfae"},
  "rooms": [[r["name"], r["level"], r["area_m2"]] for r in facts["rooms"]],
  "scope": {"Main house": ["designed", "walls, floors, roofs, openings, finishes allowance"], "Boys' quarters": ["designed", "walls, floors, roof"],
            "Site & external works": ["partial", "paving and planting drawn; boundary wall costed under external works"]},
  "quantities": [{"item": f"Walls: {k}", "qty": round(v, 1), "unit": "m²", **RR("wall_" + k, {"stone": [150_000, 185_000, 220_000], "brick": [110_000, 135_000, 160_000], "block": [65_000, 85_000, 105_000], "timber": [180_000, 230_000, 280_000]}[k]), "group": "Walls"} for k, v in wq.items()]
             + [{"item": "Windows & doors", "qty": round(op_area, 1), "unit": "m²", **RR("openings", [500_000, 650_000, 850_000]), "group": "Openings"}]
             + [{"item": f"Floors: {k}", "qty": round(v, 1), "unit": "m²", **RR("floor_" + k, {"tiled / stone floor": [110_000, 150_000, 210_000], "timber floor": [140_000, 190_000, 250_000], "external paving": [70_000, 95_000, 130_000], "landscape": [15_000, 25_000, 40_000], "rug": [0, 0, 0], "screed / other": [30_000, 40_000, 55_000]}[k]), "group": "Floors"} for k, v in fq.items() if k != "rug"]
             + [{"item": "Roof covering: clay tiles, battens, underlay, gutters", "qty": round(roof_area, 1), "unit": "m²", **RR("roof_cover", [85_000, 105_000, 130_000]), "group": "Roof"},
                {"item": "Ceilings, joinery, painting, ironmongery (allowance)", "qty": round(gfa, 1), "unit": "m² GFA", **RR("finishes_allowance", [120_000, 160_000, 220_000]), "group": "Finishes", "optional": True}],
  "checks": [["Architecture model LOD 400 (main house)", "done"], ["Room schedule", "done"], ["Building permit drawing set", "partial"], ["Door & window schedules", "partial"]],
  "drawings": [], "notes": ["Quantities from the architecture model; rates indicative Kampala 2026, replaced by the QS's."]}
for q in arch["quantities"]: q.setdefault("locked", q["group"] in ("Walls", "Roof"))
save(arch)

# ---------------- structure (from the structural design files) ----------------
P = J(SW + "/plan.json"); B = J(SW + "/build.out.json"); S = J(SW + "/sizes.json")
pairs = list(zip(P["ops"], B["ops"][2:]))
if os.path.exists(SW + "/extra.json") and os.path.exists(SW + "/extra.out.json"): pairs += list(zip(J(SW + "/extra.json"), J(SW + "/extra.out.json")["ops"]))
dj = sorted(f for f in os.listdir(WIP + "/_Structure") if f.endswith("_rc_design.json"))[-1]; D = J(WIP + "/_Structure/" + dj)
cfg = J(SW + "/config.json") if os.path.exists(SW + "/config.json") else {}
sb, sp, sl, vol = [], [], [], collections.Counter()
for o, r in pairs:
    for j, i in enumerate((r or {}).get("created_ids", [])):
        if o["op"] == "column":
            b, _ = S.get(str(i), o["size_mm"]); p = o["points_mm"][j]; z0 = -250 if o["level"].startswith("S Pad") else EL[o["level"]]
            sb.append([p[0], p[1], z0, p[0], p[1], EL[o["top_level"]], b, b]); vol["concrete"] += b * b * (EL[o["top_level"]] - z0) / 1e9
        if o["op"] == "beam":
            b, h = S.get(str(i), o["size_mm"]); z = EL[o["level"]]
            sb.append([o["start_mm"][0], o["start_mm"][1], z - h, o["end_mm"][0], o["end_mm"][1], z - h, b, h]); vol["concrete"] += b * max(0, h - (0 if z < 500 else 200)) * math.dist(o["start_mm"][:2], o["end_mm"][:2]) / 1e9
for pd in D["pads"]:
    Bw, _, t = map(int, pd["size"].split("x")); x, y = pd["at"]; sp.append([[[x - Bw / 2, y - Bw / 2], [x + Bw / 2, y - Bw / 2], [x + Bw / 2, y + Bw / 2], [x - Bw / 2, y + Bw / 2]], -1000, -1000 + t]); vol["concrete"] += Bw * Bw * t / 1e9
for s in P["plan"]["slabs"]:
    if s["level"] == (cfg.get("attic") or {}).get("level"): continue
    z = EL[s["level"]] + s.get("offset_mm", 0); sp.append([s["loops_mm"][0], z - s["thickness_mm"], z]); vol["concrete"] += area(s["loops_mm"][0]) * s["thickness_mm"] / 1000
tr = J(SW + "/trusses.json") if os.path.exists(SW + "/trusses.json") else []
for t in tr:
    (x0, y0), _ = t["plan"]
    for k in range(t["count"]):
        ox, oy = (x0 + t["overhang_mm"], y0 + 300 + k * t["spacing_mm"]) if t["along"] == "y" else (x0 + 300 + k * t["spacing_mm"], y0 + t["overhang_mm"])
        for a, b2, _ in t["mem"]:
            na, nb = t["nodes"][str(a)], t["nodes"][str(b2)]
            pt = (lambda n: [ox + n[0], oy, 7250 + n[1]]) if t["along"] == "y" else (lambda n: [ox, oy + n[0], 7250 + n[1]])
            sl.append([pt(na), pt(nb)])
steel = D["steel_kg"]["total"]; nform = vol["concrete"] * 4.2
bq_floor = sum(f["area_m2"] for f in facts["floors"] if f.get("outline_mm") and any(l["function"].lower().startswith("structure") and l["thickness_mm"] >= 100 for l in f["layers"])
               and (f["level"].startswith("BQ") or min(p[0] for p in f["outline_mm"][0]) > 14000) and "deck" not in f["type"].lower())
main_floor = sum(r["area_m2"] for r in facts["rooms"] if not r["level"].startswith("BQ"))
def truss_m3(t):   # member sizes (b x h) x lengths
    sz = t["sizes"]; return sum(m["length_mm"] / 1000 * math.prod(int(v) / 1000 for v in sz[m["kind"]].replace("+", "").split("x")) for m in t["members"])
struct = {"discipline": "structure", "label": "Structure", "status": "designed",
  "summary": "Confined-masonry RC frame on pad footings, 200 mm first-floor slab, timber attic floor and Fink roof trusses; checked for dead, imposed, wind and earthquake loads, verified in Robot.",
  "key": [[f"{vol['concrete']:,.0f} m³", "concrete"], [f"{steel / 1000:.1f} t", "steel"], [f"{len([b for b in sb if b[2] != b[5]])}", "column lengths"], [f"{sum(t['count'] for t in tr)}", "roof trusses"]],
  "model": {"mesh": "mesh/structure.web.json", "lines": sl} if os.path.exists(RD + "/mesh/structure.web.json") else {"boxes": sb, "prisms": sp, "lines": sl, "color": "#2a78d6"},
  "quantities": [{"item": "Concrete C30/37 placed", "qty": round(vol["concrete"], 1), "unit": "m³", **RR("concrete", [480_000, 550_000, 620_000]), "group": "Concrete"},
                 {"item": "Reinforcement B500, cut, bent, fixed", "qty": steel, "unit": "kg", **RR("steel", [4_600, 5_200, 5_800]), "group": "Reinforcement"},
                 {"item": "Formwork", "qty": round(nform), "unit": "m²", **RR("formwork", [30_000, 38_000, 45_000]), "group": "Formwork"},
                 {"item": "Excavation for footings", "qty": round(sum(((int(p['size'].split('x')[0]) + 600) / 1000) ** 2 * 1.25 for p in D["pads"]), 1), "unit": "m³", **RR("excavation", [25_000, 35_000, 45_000]), "group": "Earthworks"}]
             + [{"item": f"Roof trusses {t['name']} ({t['span_mm'] / 1000:.1f} m, {truss_m3(t):.3f} m³ timber each)", "qty": t["count"], "unit": "No.",
                 "rate": [round(truss_m3(t) * a + b) for a, b in zip(R("timber_truss_m3", [1_900_000, 2_300_000, 2_700_000]), R("truss_fixings", [35_000, 50_000, 70_000]))],
                 "rate_mat": [round(truss_m3(t) * a + b) for a, b in zip(RM("timber_truss_m3", [1_900_000, 2_300_000, 2_700_000]), RM("truss_fixings", [35_000, 50_000, 70_000]))],
                 "rate_lab": [round(truss_m3(t) * a) for a in RP("timber_truss_m3", "labour", [1_900_000, 2_300_000, 2_700_000], 1)], "rate_plant": [0, 0, 0], "group": "Roof structure"} for t in tr]
             + [{"item": f"Boys' quarters frame and upper floor (allowance: {bq_floor:.0f} m² at the main house's structure cost per m²; its ground slab is counted above)", "qty": round(bq_floor), "unit": "m² floor", "rate": [0, 0, 0], "rate_mat": [0, 0, 0], "group": "Allowance", "_bq": True}]
             + [{"item": "Attic timber floor (joists, 18 mm ply)", "qty": 240, "unit": "m²", **RR("attic_floor", [80_000, 95_000, 110_000]), "group": "Timber floor"}],
  "scope": {"Main house": ["designed", "frame, footings, slabs, stair, roof trusses, attic floor"], "Boys' quarters": ["allowance", "ground slab counted; frame and upper floor not designed yet"],
            "Site & external works": ["designed", "ground-bearing slabs and terraces"]},
  "checks": [["Loads: dead, imposed, wind, earthquake", "done"], ["3D analysis + independent Robot check", "done"], ["Members, slabs, stairs, footings, trusses", "done"],
             ["Bar bending schedules", "done"], ["Soil test (bearing 150 kPa assumed)", "not"], ["Engineer of record signature", "not"]],
  "drawings": [f for f in (WIP + "/_Structure/img/" + x for x in sorted(os.listdir(WIP + "/_Structure/img"))) if os.path.exists(WIP + "/_Structure/img")] if os.path.exists(WIP + "/_Structure/img") else [],
  "link": "Structural design report", "notes": []}
# price the boys' quarters allowance from the main house's own structure cost per m2 (both bases)
for q in struct["quantities"]:
    if q.get("_bq"): q.update({"rate_lab": [0, 0, 0], "rate_plant": [0, 0, 0]})
for f_ in ("rate", "rate_mat", "rate_lab", "rate_plant"):
    per = sum(q["qty"] * q[f_][i] for q in struct["quantities"] if not q.get("_bq") and q["group"] not in ("Timber floor",) for i in [1]) / max(1, main_floor)
    lo = sum(q["qty"] * q[f_][0] for q in struct["quantities"] if not q.get("_bq")) / max(1, main_floor); hi = sum(q["qty"] * q[f_][2] for q in struct["quantities"] if not q.get("_bq")) / max(1, main_floor)
    for q in struct["quantities"]:
        if q.get("_bq"): q[f_] = [round(lo * 0.8), round(per * 0.8), round(hi * 0.8)]   # 0.8: its ground slab is already counted
for q in struct["quantities"]: q.pop("_bq", None)
for q in struct["quantities"]: q.setdefault("locked", "Boys' quarters" not in q["item"])
save(struct)

# ---------------- disciplines not designed yet: honest allowance packages ----------------
build_cost = sum(q["qty"] * q["rate"][1] for q in arch["quantities"] + struct["quantities"])
build_mat = sum(q["qty"] * q["rate_mat"][1] for q in arch["quantities"] + struct["quantities"])
bnd = [w for w in facts["walls"] if "Planter wall stone" in w["type"] and w["base_level"].startswith("Site") and w["length_mm"] > 15000]
perim = sum(w["length_mm"] for w in bnd) / 1000 or 120
for disc, label, fk, frac, what in (("plumbing", "Plumbing & drainage", "plumbing_pct", R("plumbing_pct", (0.06, 0.08, 0.10)), "Water supply, hot water, sanitary fittings, soil and waste, septic tank and soakaway, rainwater and storm drainage."),
                                ("electrical", "Electrical", "electrical_pct", R("electrical_pct", (0.07, 0.09, 0.12)), "Power, lighting, distribution boards, earthing and lightning protection, data, CCTV and solar provision.")):
    save({"discipline": disc, "label": label, "status": "not_started", "summary": f"Not designed yet. {what}",
          "key": [["—", "model"], [f"{int(frac[1] * 100)}%", "of building cost (allowance)"]], "model": {},
          "scope": {"Main house": ["allowance", "share of building cost"], "Boys' quarters": ["allowance", "share of building cost"], "Site & external works": ["allowance", "external runs and connections"]},
          "quantities": split(disc, {"item": f"{label} (allowance)", "qty": 1, "unit": "sum", "rate": [round(build_cost * f) for f in frac], "rate_mat": [round(build_cost * f) for f in RM(fk, frac)], "rate_lab": [round(build_cost * f) for f in RP(fk, "labour", frac, 1)], "rate_plant": [0, 0, 0], "group": "Allowance"}),
          "checks": [["Design brief and loads", "not"], ["3D model", "not"], ["Calculations and drawings", "not"]], "drawings": [], "notes": []})
gfa_main = sum(r["area_m2"] for r in facts["rooms"]) + bq_floor * 0   # rooms of the whole project (BQ rooms included)
for disc, label, rate, unit, what, items in (
    ("mechanical", "Mechanical (ventilation, AC, solar hot water)", RR("mechanical_gfa", [40_000, 60_000, 90_000]), "m² GFA", "Extract fans to wet rooms and kitchen, split AC where wanted, solar water heating with backup.", ["Ventilation and AC layout", "Solar hot water sizing", "3D model"]),
    ("interiors", "Interiors & joinery (kitchen, wardrobes, cabinets, furniture)", RR("interiors_gfa", [180_000, 260_000, 380_000]), "m² GFA", "Kitchen units and worktops, built-in wardrobes, vanity units, shelving, doors' ironmongery upgrades, loose furniture and soft furnishing.", ["Interior design concept", "Joinery drawings and schedules", "FF&E schedule"]),
    ("fire", "Fire safety & security", RR("fire_gfa", [8_000, 12_000, 18_000]), "m² GFA", "Smoke detectors, extinguishers and blankets, emergency lighting, alarm and access control.", ["Fire strategy", "Security layout"]),
    ("landscape", "Landscape", RR("landscape_site", [25_000, 40_000, 60_000]), "m² site (approx.)", "Soft landscape, planting, irrigation points and outdoor lighting beyond the paved areas in the architecture model.", ["Landscape design", "Planting plan"])):
    qty = round(gfa_main) if "GFA" in unit else 1500
    sc = {"Site & external works": ["allowance", "per m² of site"]} if disc == "landscape" else {"Main house": ["allowance", "per m² of floor"], "Boys' quarters": ["allowance", "per m² of floor"]}
    save({"discipline": disc, "label": label, "status": "not_started", "scope": sc, "summary": f"Planned, not designed yet. {what}", "key": [["—", "model"], [f"UGX {rate['rate'][1]:,.0f}", "per " + unit + " (allowance)"]], "model": {},
          "quantities": split(disc, {"item": f"{label} (allowance)", "qty": qty, "unit": unit, **rate, "group": "Allowance"}), "checks": [[c, "not"] for c in items], "drawings": [], "notes": []})
save({"discipline": "external", "label": "External works & fence", "status": "not_started", "scope": {"Site & external works": ["allowance", "boundary wall or fence, gate"]},
      "summary": f"Boundary fence not designed yet: the architecture model shows a 1.8 m stone boundary wall of about {perim:.0f} m as a placeholder. Allowance for the wall or fence with footings, plus the gate.",
      "key": [[f"{perim:.0f} m", "boundary"], ["—", "model"]], "model": {},
      "quantities": [{"item": "Boundary wall / fence 1.8 m with footing (allowance)", "qty": round(perim), "unit": "m", **RR("fence_m", [350_000, 450_000, 600_000]), "group": "Fence"},
                     {"item": "Gate and gate house (allowance)", "qty": 1, "unit": "sum", **RR("gate", [8_000_000, 12_000_000, 18_000_000]), "group": "Fence", "optional": True}],
      "checks": [["Fence and gate design", "not"], ["Site drainage and driveway", "not"]], "drawings": [], "notes": []})
print("rates not in the kit (fallback values used):", sorted(FALLBACK) or "none")
print({p[:-5]: os.path.getsize(f"{RD}/packages/{p}") // 1024 for p in os.listdir(RD + "/packages")}, f"building cost (arch+structure likely) UGX {build_cost / 1e6:,.0f}M")
