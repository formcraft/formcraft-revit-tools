# A Revit OBJ export (fmc_scene_export: one object per element "Category_id", materials in the MTL) -> a lightweight web
# mesh for the federated model: one group per category (opaque and see-through parts apart), positions quantised to
# 16 bits, vertex colours from the Revit materials, everything gzip-compressed and base64 (the page inflates it with
# the browser's DecompressionStream).
#   python -I scripts/project/obj2web.py <in.obj> <out.json> [--drop "Entourage"] [--box "Furniture,Lighting Fixtures,Planting"]
import sys, os, json, gzip, base64, struct, re, collections
src, dst, *rest = sys.argv[1:]
drop = set(x.strip() for x in (rest[rest.index("--drop") + 1] if "--drop" in rest else "").split(",") if x.strip())
# --box: categories shown as one box shell per element (12 triangles) in the element's main colour (furniture, fittings...)
boxc = set(x.strip() for x in (rest[rest.index("--box") + 1] if "--box" in rest else "").split(",") if x.strip())
BOX = {}   # element -> [cat, min xyz, max xyz, colour counts]
mtl = {}; cur = None
for line in open(os.path.splitext(src)[0] + ".mtl", encoding="utf-8", errors="replace"):
    t = line.split()
    if not t: continue
    if t[0] == "newmtl": cur = t[1]; mtl[cur] = {"kd": (200, 200, 200), "d": 1.0}
    elif t[0] == "Kd" and cur: mtl[cur]["kd"] = tuple(int(float(x) * 255) for x in t[1:4])
    elif t[0] == "d" and cur: mtl[cur]["d"] = float(t[1])
V = []; G = collections.defaultdict(lambda: {"pos": [], "col": [], "idx": [], "map": {}}); cat = "Other"; m = None
for line in open(src, encoding="utf-8", errors="replace"):
    c = line[:2]
    if c == "v ": x, y, z = line.split()[1:4]; V.append((float(x), float(y), float(z)))
    elif c == "o ": el = line[2:].strip(); cat = re.sub(r"_\d+$", "", el).replace("_", " ")
    elif line.startswith("usemtl"): m = line.split()[1]
    elif c == "f ":
        if cat in drop: continue
        mm = mtl.get(m, {"kd": (200, 200, 200), "d": 1.0}); glass = mm["d"] < 0.95
        if cat in boxc:
            b = BOX.setdefault(el, [cat, [1e9] * 3, [-1e9] * 3, collections.Counter()])
            for p_ in line.split()[1:]:
                i = int(p_.split("/")[0]); v = V[i - 1 if i > 0 else len(V) + i]
                for k in range(3): b[1][k] = min(b[1][k], v[k]); b[2][k] = max(b[2][k], v[k])
            b[3][mm["kd"]] += 1
            continue
        g = G[(cat, glass)]
        vi = [int(p.split("/")[0]) for p in line.split()[1:]]
        vi = [i - 1 if i > 0 else len(V) + i for i in vi]
        loc = []
        for i in vi:
            key = (i, mm["kd"])
            if key not in g["map"]: g["map"][key] = len(g["pos"]) // 3; g["pos"] += V[i]; g["col"] += mm["kd"]
            loc.append(g["map"][key])
        for k in range(1, len(loc) - 1): g["idx"] += [loc[0], loc[k], loc[k + 1]]
for el, (cat, a, b, cols) in BOX.items():   # each element as a box shell
    g = G[(cat, False)]; base = len(g["pos"]) // 3; col = cols.most_common(1)[0][0]
    for x in (a[0], b[0]):
        for y in (a[1], b[1]):
            for z in (a[2], b[2]): g["pos"] += (x, y, z); g["col"] += col
    for f in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        q = [base + k for k in f]; g["idx"] += [q[0], q[1], q[2], q[0], q[2], q[3]]
allp = [p for g in G.values() for p in zip(g["pos"][0::3], g["pos"][1::3], g["pos"][2::3])]
lo = [min(p[i] for p in allp) for i in range(3)]; hi = [max(p[i] for p in allp) for i in range(3)]
span = max(h - l for l, h in zip(lo, hi)) or 1; scale = span / 65000.0
b64 = lambda b: base64.b64encode(gzip.compress(b, 9)).decode()
out = {"unit": "m", "zup": True, "offset": lo, "scale": scale, "groups": []}; stats = []
for (cat, glass), g in sorted(G.items(), key=lambda kv: -len(kv[1]["idx"])):
    n = len(g["pos"]) // 3
    q = struct.pack(f"<{n * 3}H", *[max(0, min(65535, round((v - lo[i % 3]) / scale))) for i, v in enumerate(g["pos"])])
    col = bytes(g["col"]); idx = struct.pack(f"<{len(g['idx'])}{'H' if n < 65536 else 'I'}", *g["idx"])
    out["groups"].append({"cat": cat, "glass": glass, "verts": n, "tris": len(g["idx"]) // 3, "i32": n >= 65536, "pos": b64(q), "col": b64(col), "idx": b64(idx)})
    stats.append((cat + (" (glass)" if glass else ""), len(g["idx"]) // 3))
s = json.dumps(out, separators=(",", ":")); open(dst, "w").write(s)
print(f"{dst}: {len(s) / 1e6:.2f} MB, {sum(t for _, t in stats):,} triangles in {len(stats)} groups")
for k, t in stats[:25]: print(f"  {k:40s} {t:>8,}")
