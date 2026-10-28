# Discipline packages for the project report (docs/PROJECT_REPORT.md). One JSON per discipline in <report dir>/packages:
#   {discipline, label, status: designed|in_progress|not_started, summary, key: [[value, label]], model: {boxes, prisms,
#    lines, color}, quantities: [{item, qty, unit, rate: [low, likely, high], group}], checks: [[text, done|partial|not]],
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
rates = J(RD + "/rates.json") if os.path.exists(RD + "/rates.json") else {}
R = lambda key, dflt: tuple(rates.get(key, dflt))
area = lambda lp: abs(sum(lp[i][0] * lp[(i + 1) % len(lp)][1] - lp[(i + 1) % len(lp)][0] * lp[i][1] for i in range(len(lp)))) / 2e6
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
  "model": {"boxes": boxes, "prisms": prisms, "roofs": roofs3d, "color": "#c8bfae"},
  "rooms": [[r["name"], r["level"], r["area_m2"]] for r in facts["rooms"]],
  "quantities": [{"item": f"Walls: {k}", "qty": round(v, 1), "unit": "m²", "rate": list(R("wall_" + k, {"stone": [150_000, 185_000, 220_000], "brick": [110_000, 135_000, 160_000], "block": [65_000, 85_000, 105_000], "timber": [180_000, 230_000, 280_000]}[k])), "group": "Walls"} for k, v in wq.items()]
             + [{"item": "Windows & doors", "qty": round(op_area, 1), "unit": "m²", "rate": list(R("openings", [500_000, 650_000, 850_000])), "group": "Openings"}]
             + [{"item": f"Floors: {k}", "qty": round(v, 1), "unit": "m²", "rate": list(R("floor_" + k, {"tiled / stone floor": [110_000, 150_000, 210_000], "timber floor": [140_000, 190_000, 250_000], "external paving": [70_000, 95_000, 130_000], "landscape": [15_000, 25_000, 40_000], "rug": [0, 0, 0], "screed / other": [30_000, 40_000, 55_000]}[k])), "group": "Floors"} for k, v in fq.items() if k != "rug"]
             + [{"item": "Roof covering: clay tiles, battens, underlay, gutters", "qty": round(roof_area, 1), "unit": "m²", "rate": list(R("roof_cover", [85_000, 105_000, 130_000])), "group": "Roof"},
                {"item": "Ceilings, joinery, painting, ironmongery (allowance)", "qty": round(gfa, 1), "unit": "m² GFA", "rate": list(R("finishes_allowance", [120_000, 160_000, 220_000])), "group": "Finishes"}],
  "checks": [["Architecture model LOD 400 (main house)", "done"], ["Room schedule", "done"], ["Building permit drawing set", "partial"], ["Door & window schedules", "partial"]],
  "drawings": [], "notes": ["Quantities from the architecture model; rates indicative Kampala 2026, replaced by the QS's."]}
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
struct = {"discipline": "structure", "label": "Structure", "status": "designed",
  "summary": "Confined-masonry RC frame on pad footings, 200 mm first-floor slab, timber attic floor and Fink roof trusses; checked for dead, imposed, wind and earthquake loads, verified in Robot.",
  "key": [[f"{vol['concrete']:,.0f} m³", "concrete"], [f"{steel / 1000:.1f} t", "steel"], [f"{len([b for b in sb if b[2] != b[5]])}", "column lengths"], [f"{sum(t['count'] for t in tr)}", "roof trusses"]],
  "model": {"boxes": sb, "prisms": sp, "lines": sl, "color": "#2a78d6"},
  "quantities": [{"item": "Concrete C30/37 placed", "qty": round(vol["concrete"], 1), "unit": "m³", "rate": list(R("concrete", [480_000, 550_000, 620_000])), "group": "Concrete"},
                 {"item": "Reinforcement B500, cut, bent, fixed", "qty": steel, "unit": "kg", "rate": list(R("steel", [4_600, 5_200, 5_800])), "group": "Reinforcement"},
                 {"item": "Formwork", "qty": round(nform), "unit": "m²", "rate": list(R("formwork", [30_000, 38_000, 45_000])), "group": "Formwork"},
                 {"item": "Excavation for footings", "qty": round(sum(((int(p['size'].split('x')[0]) + 600) / 1000) ** 2 * 1.25 for p in D["pads"]), 1), "unit": "m³", "rate": list(R("excavation", [25_000, 35_000, 45_000])), "group": "Earthworks"}]
             + [{"item": f"Roof trusses {t['name']} ({t['span_mm'] / 1000:.1f} m)", "qty": t["count"], "unit": "No.", "rate": list(R("truss_" + t["name"], [620_000, 720_000, 820_000] if t["span_mm"] > 11000 else [440_000, 520_000, 600_000])), "group": "Roof structure"} for t in tr]
             + [{"item": "Attic timber floor (joists, 18 mm ply)", "qty": 240, "unit": "m²", "rate": list(R("attic_floor", [80_000, 95_000, 110_000])), "group": "Timber floor"}],
  "checks": [["Loads: dead, imposed, wind, earthquake", "done"], ["3D analysis + independent Robot check", "done"], ["Members, slabs, stairs, footings, trusses", "done"],
             ["Bar bending schedules", "done"], ["Soil test (bearing 150 kPa assumed)", "not"], ["Engineer of record signature", "not"]],
  "drawings": [f for f in (WIP + "/_Structure/img/" + x for x in sorted(os.listdir(WIP + "/_Structure/img"))) if os.path.exists(WIP + "/_Structure/img")] if os.path.exists(WIP + "/_Structure/img") else [],
  "link": "Structural design report", "notes": []}
save(struct)

# ---------------- disciplines not designed yet: honest allowance packages ----------------
build_cost = sum(q["qty"] * q["rate"][1] for q in arch["quantities"] + struct["quantities"])
bnd = [w for w in facts["walls"] if "Planter wall stone" in w["type"] and w["base_level"].startswith("Site") and w["length_mm"] > 15000]
perim = sum(w["length_mm"] for w in bnd) / 1000 or 120
for disc, label, frac, what in (("plumbing", "Plumbing & drainage", (0.06, 0.08, 0.10), "Water supply, hot water, sanitary fittings, soil and waste, septic tank and soakaway, rainwater and storm drainage."),
                                ("electrical", "Electrical", (0.07, 0.09, 0.12), "Power, lighting, distribution boards, earthing and lightning protection, data, CCTV and solar provision.")):
    save({"discipline": disc, "label": label, "status": "not_started", "summary": f"Not designed yet. {what}",
          "key": [["—", "model"], [f"{int(frac[1] * 100)}%", "of building cost (allowance)"]], "model": {},
          "quantities": [{"item": f"{label} (allowance, {int(frac[0] * 100)}–{int(frac[2] * 100)}% of building cost)", "qty": 1, "unit": "sum", "rate": [round(build_cost * f) for f in frac], "group": "Allowance"}],
          "checks": [["Design brief and loads", "not"], ["3D model", "not"], ["Calculations and drawings", "not"]], "drawings": [], "notes": []})
gfa_main = sum(r["area_m2"] for r in facts["rooms"])
for disc, label, rate, unit, what, items in (
    ("mechanical", "Mechanical (ventilation, AC, solar hot water)", [40_000, 60_000, 90_000], "m² GFA", "Extract fans to wet rooms and kitchen, split AC where wanted, solar water heating with backup.", ["Ventilation and AC layout", "Solar hot water sizing", "3D model"]),
    ("interiors", "Interiors & joinery (kitchen, wardrobes, cabinets, furniture)", [180_000, 260_000, 380_000], "m² GFA", "Kitchen units and worktops, built-in wardrobes, vanity units, shelving, doors' ironmongery upgrades, loose furniture and soft furnishing.", ["Interior design concept", "Joinery drawings and schedules", "FF&E schedule"]),
    ("fire", "Fire safety & security", [8_000, 12_000, 18_000], "m² GFA", "Smoke detectors, extinguishers and blankets, emergency lighting, alarm and access control.", ["Fire strategy", "Security layout"]),
    ("landscape", "Landscape", [25_000, 40_000, 60_000], "m² site (approx.)", "Soft landscape, planting, irrigation points and outdoor lighting beyond the paved areas in the architecture model.", ["Landscape design", "Planting plan"])):
    qty = round(gfa_main) if "GFA" in unit else 1500
    save({"discipline": disc, "label": label, "status": "not_started", "summary": f"Planned, not designed yet. {what}", "key": [["—", "model"], [f"UGX {rate[1]:,}", "per " + unit + " (allowance)"]], "model": {},
          "quantities": [{"item": f"{label} (allowance)", "qty": qty, "unit": unit, "rate": rate, "group": "Allowance"}], "checks": [[c, "not"] for c in items], "drawings": [], "notes": []})
save({"discipline": "external", "label": "External works & fence", "status": "not_started",
      "summary": f"Boundary fence not designed yet: the architecture model shows a 1.8 m stone boundary wall of about {perim:.0f} m as a placeholder. Allowance for the wall or fence with footings, plus the gate.",
      "key": [[f"{perim:.0f} m", "boundary"], ["—", "model"]], "model": {},
      "quantities": [{"item": "Boundary wall / fence 1.8 m with footing (allowance)", "qty": round(perim), "unit": "m", "rate": list(R("fence_m", [350_000, 450_000, 600_000])), "group": "Fence"},
                     {"item": "Gate and gate house (allowance)", "qty": 1, "unit": "sum", "rate": list(R("gate", [8_000_000, 12_000_000, 18_000_000])), "group": "Fence"}],
      "checks": [["Fence and gate design", "not"], ["Site drainage and driveway", "not"]], "drawings": [], "notes": []})
print({p[:-5]: os.path.getsize(f"{RD}/packages/{p}") // 1024 for p in os.listdir(RD + "/packages")}, f"building cost (arch+structure likely) UGX {build_cost / 1e6:,.0f}M")
