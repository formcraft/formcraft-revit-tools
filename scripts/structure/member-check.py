# usage: python -I scripts/structure/member-check.py <work dir> <robot runs dir> <run>
# Member check of a Robot run (EC2 simplified, C25/30, B500, d = h - 50) and the sizes that must change.
# PRELIMINARY - no engineer of record. Beams: M_Ed <= 0.156 fck b d^2 (no compression steel). Columns: N/N_Rd + M/M_Rd <= 1,
# 1% steel, M at least N x max(h/30, 20 mm). Writes sizes.json (Revit id -> [b, h]) for the next run and the Revit ops.
import json, sys
W, D, RUN = sys.argv[1], sys.argv[2].rstrip("/\\") + "/", sys.argv[3]
run = json.load(open(D + RUN + ".json")); res = {b["n"]: b for b in json.load(open(D + RUN + "_results.json"))["bars"]}
try: sizes = json.load(open(W + "/sizes.json"))
except FileNotFoundError: sizes = {}
fck, fy = 25, 500
COL = [230, 250, 300, 350, 400, 450, 500, 600]
def vrd_max(b, h): d = h - 50; return 0.5 * b * 0.9 * d * 0.6 * (1 - fck / 250) * fck / 1.5 / 1000   # theta 45, links take the rest
def beam_ok(b, h, M, V=0): d = h - 50; return M <= 0.156 * fck * b * d * d / 1e6 and V <= vrd_max(b, h)
def col_ratio(a, N, My, Mz=0, V=0, rho=0.01):
    A = a * a; As = rho * A
    NRd = (0.4 * fck * A + 0.67 * fy * As) / 1000; MRd = 0.87 * fy * As / 2 * (a - 100) / 1e6
    e = N * max(a / 30, 20) / 1000; My, Mz = max(My, e), max(Mz, e) if Mz else Mz
    hi, lo = max(My, Mz), min(My, Mz)
    return max(N / NRd + (hi + 0.5 * lo) / MRd, V / vrd_max(a, a))
rows, changes, rhos = [], {}, {}
for b in run["bars"]:
    if b["kind"] == "strut": continue   # infill struts: analysis only
    r = res.get(b["n"]); N, M = r["ned_kn"], r["med_knm"]; My, Mz, V = r.get("my_knm", M), r.get("mz_knm", 0), r.get("ved_kn", 0); bw, h = sizes.get(str(b["id"]), [b["b_mm"], b["h_mm"]])
    if b["kind"] == "beam":
        ok = beam_ok(bw, h, M, V); nb, nh = bw, h
        while not beam_ok(nb, nh, M, V):
            if nh < 600: nh += 50
            else: nb, nh = 300, max(450, nh - 100) if nb < 300 else nh + 50
        u = max(M / (0.156 * fck * bw * (h - 50) ** 2 / 1e6), V / vrd_max(bw, h))
    else:
        # owner 28 Oct: least concrete: more steel (1% to 3%) before a bigger column
        RH = [0.01, 0.0125, 0.015, 0.0175, 0.02, 0.025, 0.03]
        need = lambda a: next((r for r in RH if col_ratio(a, N, My, Mz, V, r) <= 1), None)
        rho0 = need(bw); u = col_ratio(bw, N, My, Mz, V, rho0 or 0.03); ok = rho0 is not None; nb = bw
        while need(nb) is None and nb < 600: nb = COL[COL.index(nb) + 1] if nb in COL else 300
        nh = nb; rhos[str(b["id"])] = need(nb) or 0.03
    rows.append((b["kind"], b["id"], b["n"], f"{bw}x{h}", N, M, round(u, 2), ok, f"{nb}x{nh}"))
    if [nb, nh] != [bw, h]: changes[str(b["id"])] = [nb, nh]
fails = [x for x in rows if not x[7]]
print("members", len(rows), "over capacity", len(fails))
for k in ("beam", "column"):
    xs = [x for x in rows if x[0] == k]; print(k, "max utilisation", max(x[6] for x in xs), "failing", sum(1 for x in xs if not x[7]))
for x in sorted(fails, key=lambda x: -x[6])[:25]: print("  ", x)
# storey drift under EX / EY: design = elastic x 5/K, limit 0.010 h and 60 mm (kit seismic.drift)
allres = json.load(open(D + RUN + "_results.json"))
if allres.get("nodes"):
    disp = {n["node"]: max(n["ux_mm"], n["uy_mm"]) for n in allres["nodes"]}; K = allres["seismic"]["K"]; f = 5 / K
    ff = list(allres["levels"].values())[-2]; rf = list(allres["levels"].values())[-1]
    d1 = max(disp[n] for n in ff["nodes"]) * f; h1 = ff["elevation_mm"] + 250
    d2 = max(abs(disp[a] - disp.get(b, 0)) for a, b in allres["stacks"]) * f; h2 = rf["elevation_mm"] - ff["elevation_mm"]
    print("drift GF storey %.1f mm (limit %.0f), FF storey %.1f mm (limit %.0f)" % (d1, min(0.01 * h1, 60), d2, min(0.01 * h2, 60)))
    if d1 > min(0.01 * h1, 60) or d2 > min(0.01 * h2, 60): print("DRIFT EXCEEDED: stiffen (bigger columns)")
sizes.update(changes); json.dump(sizes, open(W + "/sizes.json", "w"))
# Revit: the sized type (RC bxh), made from an existing one when missing, then change_type
ops = []; have = set()
cat = {"beam": "Structural Framing", "column": "Structural Columns"}
kinds = {str(b["id"]): b["kind"] for b in run["bars"] if b["kind"] != "strut"}
by = {}
for i, (b, h) in changes.items(): by.setdefault((kinds[i], b, h), []).append(int(i))
for (k, b, h), ids in by.items():
    ops.append({"op": "change_type", "ids": ids, "type_name": f"RC {b}x{h}", "_make": {"category": cat[k], "b": b, "h": h}})
json.dump(ops, open(W + "/resize.json", "w"))
print("changes", len(changes), "types", sorted(f"{k} {b}x{h}: {len(v)}" for (k, b, h), v in by.items()))
json.dump(rows, open(D + RUN + "_check.json", "w")); json.dump(rhos, open(W + "/rho.json", "w"))
