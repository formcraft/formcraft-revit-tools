# Audit of the structural analysis against the Revit model as it is now: every column, beam and slab compared by id
# (position, height, size), members on one side only, the analysed frame's connectivity (beam ends with no support,
# columns standing on beams, free ends), stairs, and the method itself. Writes <work>/model_audit.json.
#   python -I scripts/structure/model-audit.py <work dir> <runs dir> <structure.obj> <facts_now.json>
import json, sys, re, math, collections
W, O, OBJ, FN = sys.argv[1:5]
J = lambda p: json.load(open(p, encoding="utf-8"))
run = open(W + "/last_run.txt").read().strip(); M = J(f"{O}/{run}_model.json")["model"]; RJ = J(f"{O}/{run}.json")
facts, sizes, plan = J(FN), J(W + "/sizes.json"), J(W + "/plan.json")
N = {n["n"]: n for n in M["nodes"]}; sup = set(M["supports"]) if isinstance(M["supports"][0], int) else {s.get("node", s.get("n")) for s in M["supports"]}
# ---- Revit geometry now (OBJ export: one object per element, metres)
V, BB, cur = [], {}, None
for line in open(OBJ, encoding="utf-8", errors="replace"):
    if line.startswith("v "): V.append(tuple(float(x) * 1000 for x in line.split()[1:4]))
    elif line.startswith("o "): cur = line[2:].strip()
    elif line.startswith("f ") and cur:
        b = BB.setdefault(cur, [[1e12] * 3, [-1e12] * 3])
        for p in line.split()[1:]:
            i = int(p.split("/")[0]); v = V[i - 1 if i > 0 else len(V) + i]
            for k in range(3): b[0][k] = min(b[0][k], v[k]); b[1][k] = max(b[1][k], v[k])
cat = lambda k: re.sub(r"_\d+$", "", k).replace("_", " ")
eid = lambda k: int(re.search(r"_(\d+)$", k).group(1))
RC = {eid(k): b for k, b in BB.items() if cat(k) == "Structural Columns"}
RF = {f["id"]: f for f in facts["framing"]}
RFL = {eid(k) for k, b in BB.items() if cat(k) == "Floors"}
A = collections.defaultdict(list)
for b in M["bars"]: A[b["kind"]].append(b)
AC = {b["id"]: b for b in A["column"]}; AB = {b["id"]: b for b in A["beam"]}
xyz = lambda n: (N[n]["x"], N[n]["y"], N[n]["z"])
F = []   # findings: severity, area, text, ids
def find(sev, area, text, ids=()): F.append({"severity": sev, "area": area, "text": text, "ids": list(ids)[:60], "count": len(list(ids))})

# ---- columns
off, ht, sz = [], [], []
for i, b in AC.items():
    r = RC.get(i)
    if not r: continue
    a, e = xyz(b["start"]), xyz(b["end"]); cx, cy = (r[0][0] + r[1][0]) / 2, (r[0][1] + r[1][1]) / 2
    if math.hypot(cx - a[0], cy - a[1]) > 50: off.append((i, round(math.hypot(cx - a[0], cy - a[1]))))
    cut = 0 < e[2] - r[1][2] <= 700   # Revit cuts a column where a beam joins it: the analytical line runs to the beam centre
    if (abs(r[1][2] - e[2]) > 150 and not cut) or abs(r[0][2] - a[2]) > 300: ht.append((i, round(r[0][2]), round(r[1][2]), a[2], e[2]))
    w = round(min(r[1][0] - r[0][0], r[1][1] - r[0][1])); s = sizes.get(str(i), [b["b_mm"]])[0]
    if abs(w - s) > 15: sz.append((i, w, s))
only_r = sorted(set(RC) - set(AC)); only_a = sorted(set(AC) - set(RC))
if off: find("high", "Columns", f"{len(off)} column(s) analysed at a different plan position from Revit (worst {max(x[1] for x in off)} mm)", [x[0] for x in off])
if ht: find("high", "Columns", f"{len(ht)} column(s) with a different base or top level in Revit than in the analysis", [x[0] for x in ht])
if sz: find("medium", "Columns", f"{len(sz)} column(s) whose Revit size differs from the designed size", [x[0] for x in sz])
if only_r: find("high", "Columns", f"{len(only_r)} column(s) in Revit but not in the analysis", only_r)
if only_a: find("high", "Columns", f"{len(only_a)} analysed column(s) missing from Revit", only_a)
# ---- beams
boff = []
def off_line(p, s0, s1):   # distance of p from the Revit beam's line segment, plan
    dx, dy = s1[0] - s0[0], s1[1] - s0[1]; L2 = dx * dx + dy * dy or 1; u = max(0, min(1, ((p[0] - s0[0]) * dx + (p[1] - s0[1]) * dy) / L2))
    return math.hypot(p[0] - s0[0] - u * dx, p[1] - s0[1] - u * dy)
for b in A["beam"]:   # every analysed segment (a beam split where a column or beam meets it) lies on its Revit beam
    f = RF.get(b["id"])
    if not f or not f.get("start_mm"): continue
    d = max(off_line(xyz(n), f["start_mm"], f["end_mm"]) for n in (b["start"], b["end"]))
    if d > 100: boff.append((b["id"], round(d)))
if boff: find("high", "Beams", f"{len(boff)} beam(s) analysed on a different line from Revit (worst {max(x[1] for x in boff)} mm)", [x[0] for x in boff])
gl = [i for i, f in RF.items() if i not in AB and f.get("start_mm") and f["start_mm"][2] < 600]
ol = [i for i, f in RF.items() if i not in AB and i not in gl]
if gl: find("medium", "Beams", f"{len(gl)} ground beams are designed by hand (wall load, continuous) but are not in the frame: they tie the pads together in an earthquake and carry no frame moments in the analysis", gl)
if ol: find("high", "Beams", f"{len(ol)} beam(s) above ground in Revit are not in the analysed frame", ol)
# ---- connectivity of the analysed frame
deg = collections.Counter(); kinds = collections.defaultdict(set)
for b in M["bars"]:
    if b["kind"] == "strut": continue
    for n in (b["start"], b["end"]): deg[n] += 1; kinds[n].add(b["kind"])
free = [n for n, c in deg.items() if c == 1 and n not in sup]
col_ends = {b["end"] for b in A["column"]}
onbeam = [b["id"] for b in A["column"] if b["start"] not in sup and b["start"] not in col_ends]
if free: find("high", "Connectivity", f"{len(free)} free end(s) in the analysed frame (a member end with nothing else attached and no support)", free)
if onbeam: find("high", "Connectivity", f"{len(onbeam)} column(s) standing on a beam, not on a column below (a transfer: the beam carries the column)", onbeam)
nsup = [n for n in sup if N[n]["z"] > 0]
if nsup: find("medium", "Connectivity", f"{len(nsup)} support(s) above ground level", nsup)
# ---- stairs (slabs are the architect's floors in the linked model: checked by the loads take-down, not here)
if not A["stair"]: find("high", "Stairs", "No stair in the analysis: its weight and its stiffness bracing the floors are missing (a monolithic stair acts as a diagonal strut in an earthquake). Add it (stairs.json) or detail a sliding joint at the landing.")
# ---- method (from robot-run.mjs as written)
if not any(c["name"] in ("TX", "TY") for c in RJ["form"]["cases"]): find("high", "Earthquake", "No accidental torsion: EN 1998-1 4.3.2 moves each storey force by ±5% of the plan size.")
st = len(A["strut"]); find("medium", "Infill", f"{st} masonry infill struts stiffen the frame in the analysis. The drift and the column forces rely on them: a bare-frame run (no infill) must be checked too, because walls get cut, removed or built late.")
if RJ.get("solver") != "frame3d" and not RJ.get("calculated", True): find("high", "Robot", "The last Robot run did not calculate (status -1): its results are not a valid check.")
json.dump({"run": run, "revit": {"columns": len(RC), "framing": len(RF), "floors": len(RFL), "stairs": len(facts.get("stairs", []))},
           "analysis": {k: len(v) for k, v in A.items()}, "findings": F}, open(W + "/model_audit.json", "w"), indent=1)
print(f"Revit: {len(RC)} columns, {len(RF)} beams, {len(RFL)} floors, {len(facts.get('stairs', []))} stairs | analysis: " + ", ".join(f"{len(v)} {k}s" for k, v in A.items()))
for f in sorted(F, key=lambda x: x["severity"] != "high"): print(f"[{f['severity']:6s}] {f['area']:12s} {f['text'][:200]}" + (f"  ids: {f['ids'][:8]}" if f["ids"] else ""))
