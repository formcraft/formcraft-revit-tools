# Linear-elastic 3D frame solver: the same model and form robot-run.mjs sends to Robot, the same results JSON the Robot
# connector returns (bars: N, My, Mz, V and their governing case; nodes: horizontal displacements). So the design loop
# runs without Robot (fast, no licence, no COM hang-ups) and Robot is kept for the independent final check.
#   python scripts/structure/frame3d.py <model+form json> <results json>      (numpy: not -I)
# Members: 3D Euler-Bernoulli beams (kind column/beam), axial-only bars (kind strut: infill, shear-wall braces,
# diaphragm ties). Concrete E 31 GPa; flexural stiffness x0.5 for cracking (EC8 4.3.1(7)) unless "cracked": false.
# Loads: case self-weight (-Z, 25 kN/m3 on frame members), bar_loads (kN/m down, global), node_loads (kN).
# Supports: Fixed (6 dof) or Pinned (3 translations). Combinations: linear sums of the cases.
import json, math, sys
import numpy as np

IN, OUTF = sys.argv[1], sys.argv[2]
d = json.load(open(IN)); model, form = d["model"], d["form"]
E, G = 31000e3, 31000e3 / 2.4                     # kN/m2
CR = 0.5 if form.get("cracked", True) else 1.0
nodes = {n["n"]: np.array([n["x"], n["y"], n["z"]]) / 1000 for n in model["nodes"]}
nid = {k: i for i, k in enumerate(sorted(nodes))}; ndof = 6 * len(nid)

def axes(a, b):
    ex = (b - a) / np.linalg.norm(b - a)
    ref = np.array([1.0, 0, 0]) if abs(ex[2]) > 0.99 else np.array([0, 0, 1.0])
    ey = np.cross(ref, ex); ey /= np.linalg.norm(ey); ez = np.cross(ex, ey)
    return np.vstack([ex, ey, ez])

def section(b):
    w, h = b["b_mm"] / 1000, b["h_mm"] / 1000
    A = w * h; Iy = w * h ** 3 / 12; Iz = h * w ** 3 / 12
    s, l = min(w, h), max(w, h); J = l * s ** 3 * (1 / 3 - 0.21 * s / l * (1 - (s / l) ** 4 / 12))
    return A, Iy, Iz, J

def k_local(L, A, Iy, Iz, J, truss):
    k = np.zeros((12, 12))
    ea = E * A / L; k[0, 0] = k[6, 6] = ea; k[0, 6] = k[6, 0] = -ea
    if truss: return k
    EIz, EIy = CR * E * Iz, CR * E * Iy; GJ = G * J / L
    k[3, 3] = k[9, 9] = GJ; k[3, 9] = k[9, 3] = -GJ
    for (v1, t1, v2, t2, EI, sg) in ((1, 5, 7, 11, EIz, 1), (2, 4, 8, 10, EIy, -1)):
        c = EI / L ** 3
        m = np.array([[12, 6 * L * sg, -12, 6 * L * sg], [6 * L * sg, 4 * L * L, -6 * L * sg, 2 * L * L],
                      [-12, -6 * L * sg, 12, -6 * L * sg], [6 * L * sg, 2 * L * L, -6 * L * sg, 4 * L * L]]) * c
        idx = [v1, t1, v2, t2]
        for i in range(4):
            for j in range(4): k[idx[i], idx[j]] += m[i, j]
    return k

bars = []
K = np.zeros((ndof, ndof))
for b in model["bars"]:
    a, c = nodes[b["start"]], nodes[b["end"]]; L = float(np.linalg.norm(c - a)); R = axes(a, c)
    T = np.zeros((12, 12))
    for i in range(4): T[3 * i:3 * i + 3, 3 * i:3 * i + 3] = R
    A, Iy, Iz, J = section(b); truss = b.get("kind") == "strut"
    kl = k_local(L, A, Iy, Iz, J, truss); kg = T.T @ kl @ T
    dofs = [6 * nid[b["start"]] + i for i in range(6)] + [6 * nid[b["end"]] + i for i in range(6)]
    K[np.ix_(dofs, dofs)] += kg
    bars.append({"b": b, "L": L, "R": R, "T": T, "kl": kl, "dofs": dofs, "A": A, "truss": truss})

fixed = set()
for n in model["supports"]:
    for i in range(6 if form["supports"] == "Fixed" else 3): fixed.add(6 * nid[n] + i)
# struts-only nodes and torsion-free spots: tiny springs keep the matrix regular
K += np.eye(ndof) * 1e-6
free = [i for i in range(ndof) if i not in fixed]

def fef(q_local, L):
    """Fixed-end forces (local, the forces the member puts on its nodes are minus these) for a uniform load q = (qx, qy, qz)."""
    qx, qy, qz = q_local; f = np.zeros(12)
    f[0] = f[6] = qx * L / 2
    f[1] = f[7] = qy * L / 2; f[5] = qy * L * L / 12; f[11] = -qy * L * L / 12
    f[2] = f[8] = qz * L / 2; f[4] = -qz * L * L / 12; f[10] = qz * L * L / 12
    return f

cases = form["cases"]; per_case = {}
for c in cases:
    F = np.zeros(ndof); q_bar = {}
    w_by_bar = {l["bar"]: l["w_kn_m"] for l in c.get("bar_loads", [])}
    for i, br in enumerate(bars):
        qg = np.zeros(3)
        if c.get("self_weight") and not br["truss"]: qg[2] -= 25 * br["A"]
        if br["b"]["n"] in w_by_bar: qg[2] -= w_by_bar[br["b"]["n"]]
        if not qg.any(): continue
        ql = br["R"] @ qg; fe = fef(ql, br["L"]); q_bar[i] = ql
        F[br["dofs"]] += br["T"].T @ fe
    for l in c.get("node_loads", []):
        base = 6 * nid[l["node"]]; F[base] += l.get("fx_kn", 0); F[base + 1] += l.get("fy_kn", 0); F[base + 2] += l.get("fz_kn", 0)
    u = np.zeros(ndof); u[free] = np.linalg.solve(K[np.ix_(free, free)], F[free])
    # internal forces at 5 points: F_int(x) = -f1 - q x;  M_int(x) = -m1 + x e1 x f1 + (x/2) e1 x (q x)
    forces = []
    for i, br in enumerate(bars):
        ql = q_bar.get(i, np.zeros(3)); fe = fef(ql, br["L"])
        f = br["kl"] @ (br["T"] @ u[br["dofs"]]) - fe
        f1, m1 = f[0:3], f[3:6]; e1 = np.array([1.0, 0, 0]); pts = []
        for xi in (0, 0.25, 0.5, 0.75, 1.0):
            x = xi * br["L"]; Fi = -f1 - ql * x; Mi = -m1 + np.cross(x * e1, f1) + np.cross(x / 2 * e1, ql * x)
            pts.append(np.concatenate([Fi, Mi]))
        forces.append(np.array(pts))
    per_case[c["name"]] = (u, forces)

combos = {c["name"]: c["factors"] for c in form.get("combinations", [])}
allc = {n: {n: 1.0} for n in per_case} | combos
out_bars = []
for i, br in enumerate(bars):
    best = {"N": (0, ""), "M": (0, ""), "My": 0, "Mz": 0, "V": 0}
    for name, fac in allc.items():
        P = sum(f * per_case[k][1][i] for k, f in fac.items())
        N = float(np.max(np.abs(P[:, 0]))); Vy = float(np.max(np.abs(P[:, 1]))); Vz = float(np.max(np.abs(P[:, 2])))
        My = float(np.max(np.abs(P[:, 4]))); Mz = float(np.max(np.abs(P[:, 5])))
        if N > best["N"][0]: best["N"] = (N, name)
        if max(My, Mz) > best["M"][0]: best["M"] = (max(My, Mz), name)
        best["My"] = max(best["My"], My); best["Mz"] = max(best["Mz"], Mz); best["V"] = max(best["V"], Vy, Vz)
    b = br["b"]
    out_bars.append({"n": b["n"], "id": b["id"], "ned_kn": round(best["N"][0], 1), "med_knm": round(best["M"][0], 1), "ned_case": best["N"][1], "med_case": best["M"][1],
                     "my_knm": round(best["My"], 1), "mz_knm": round(best["Mz"], 1), "ved_kn": round(best["V"], 1)})
out_nodes = []
want = d.get("node_cases") or [c["name"] for c in cases]
for n in d.get("nodes", []):
    ux = max(abs(per_case[c][0][6 * nid[n]]) for c in want if c in per_case) * 1000
    uy = max(abs(per_case[c][0][6 * nid[n] + 1]) for c in want if c in per_case) * 1000
    out_nodes.append({"node": n, "ux_mm": round(ux, 2), "uy_mm": round(uy, 2)})
json.dump({"solver": "frame3d", "cases": len(allc), "bars": out_bars, "nodes": out_nodes}, open(OUTF, "w"), indent=1)
print(json.dumps({"bars": len(out_bars), "nodes": len(out_nodes), "dof": ndof}))
