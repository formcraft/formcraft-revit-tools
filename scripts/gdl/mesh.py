"""Mesh the same IR the GDL is generated from, in object coordinates (m), for previews and checks."""
import math, numpy as np, sys, os
sys.path.insert(0, os.path.dirname(__file__))
import ir

def _tri_poly(pts):
    """Ear-clip a simple 2D polygon -> index triangles."""
    n = len(pts); idx = list(range(n))
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    if area < 0: idx.reverse()
    tris = []; guard = 0
    def inside(p, a, b, c):
        def s(p1, p2, p3): return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
        d1, d2, d3 = s(p, a, b), s(p, b, c), s(p, c, a)
        return not (((d1 < 0) or (d2 < 0) or (d3 < 0)) and ((d1 > 0) or (d2 > 0) or (d3 > 0)))
    while len(idx) > 3 and guard < 10000:
        guard += 1; ok = False
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = pts[i0], pts[i1], pts[i2]
            if (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) <= 1e-12: continue
            if any(inside(pts[j], a, b, c) for j in idx if j not in (i0, i1, i2)): continue
            tris.append((i0, i1, i2)); idx.pop(k); ok = True; break
        if not ok: break
    if len(idx) == 3: tris.append(tuple(idx))
    return tris

def solid_tris(s, seg):
    """Triangles in recipe world mm."""
    T = []
    k = s['kind']
    if k == 'box':
        x0, y0, z0, x1, y1, z1 = s['box']
        v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        for a, b, c, d in [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]:
            T += [(v[a], v[b], v[c]), (v[a], v[c], v[d])]
    elif k == 'extrude':
        pts = [tuple(p) for p in s['points']]
        if pts[0] == pts[-1]: pts = pts[:-1]
        lo, hi = s['start'], s['end']
        W = lambda u, v, w: ir.to_world_extrude(s['sketch'], u, v, w)
        for (i0, i1, i2) in _tri_poly(pts):
            T.append((W(*pts[i0], lo), W(*pts[i2], lo), W(*pts[i1], lo)))
            T.append((W(*pts[i0], hi), W(*pts[i1], hi), W(*pts[i2], hi)))
        n = len(pts)
        for i in range(n):
            a, b = pts[i], pts[(i + 1) % n]
            T += [(W(*a, lo), W(*b, lo), W(*b, hi)), (W(*a, lo), W(*b, hi), W(*a, hi))]
    elif k == 'revolve':
        prof = [tuple(p) for p in s['profile']]
        closed = not (prof[0][0] == 0 or prof[-1][0] == 0)
        if closed and prof[0] != prof[-1]: prof = prof + [prof[0]]
        ring = lambda r, t, j: ir.to_world_revolve(s.get('axis'), s['axis_at'], r, t, 2 * math.pi * j / seg)
        for i in range(len(prof) - 1):
            (r0, t0), (r1, t1) = prof[i], prof[i + 1]
            for j in range(seg):
                a, b = ring(r0, t0, j), ring(r0, t0, j + 1)
                c, d = ring(r1, t1, j + 1), ring(r1, t1, j)
                T += [(a, b, c), (a, c, d)]
        if not closed:
            for (r, t) in (prof[0], prof[-1]):
                if r > 0:
                    cen = ring(0, t, 0)
                    for j in range(seg): T.append((cen, ring(r, t, j), ring(r, t, j + 1)))
    elif k == 'tube':
        prof = [tuple(p) for p in s['profile']]
        path = [np.array(ir.to_world_path(s['path_plane'], s['at'], u, v), float) for (u, v) in s['path']]
        path = [p for i, p in enumerate(path) if i == 0 or np.linalg.norm(p - path[i - 1]) > 1e-6]
        if len(path) < 2: return T
        # frame: tangent + a fixed reference
        rings = []
        for i, p in enumerate(path):
            if i == 0: t = path[1] - path[0]
            elif i == len(path) - 1: t = path[-1] - path[-2]
            else: t = (path[i + 1] - path[i]) / np.linalg.norm(path[i + 1] - path[i]) + (path[i] - path[i - 1]) / np.linalg.norm(path[i] - path[i - 1])
            t = t / (np.linalg.norm(t) + 1e-12)
            ref = np.array([0, 0, 1.0]) if abs(t[2]) < 0.9 else np.array([1.0, 0, 0])
            u = np.cross(t, ref); u /= np.linalg.norm(u); w = np.cross(t, u)
            rings.append([tuple(p + a * u + b * w) for (a, b) in prof])
        n = len(prof)
        for i in range(len(rings) - 1):
            for j in range(n):
                a, b = rings[i][j], rings[i][(j + 1) % n]
                c, d = rings[i + 1][(j + 1) % n], rings[i + 1][j]
                T += [(a, b, c), (a, c, d)]
    return T

def object_mesh(o_solids, blo, ceiling, seg=36):
    """List of (tris (N,3,3) in m, material name)."""
    out = []
    for s in o_solids:
        tr = np.array(solid_tris(s, seg), float)
        if len(tr) == 0: continue
        if ceiling: tr[..., 1] *= -1; tr[..., 2] *= -1
        tr = (tr - np.array(blo)) / 1000.0
        out.append((tr, s.get('material'), s['name']))
    return out
