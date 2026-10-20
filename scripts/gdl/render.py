"""Small z-buffer renderer for previews (orthographic, flat Lambert + specular, 2x supersampled)."""
import numpy as np, math
from PIL import Image

def hex_rgb(h):
    h = (h or '#B4B4B4').lstrip('#'); return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], float) / 255

def view_matrix(az_deg, el_deg):
    az, el = math.radians(az_deg), math.radians(el_deg)
    # camera looks from direction d toward origin
    d = np.array([math.cos(el) * math.sin(az), -math.cos(el) * math.cos(az), math.sin(el)])
    f = -d
    up = np.array([0, 0, 1.0])
    r = np.cross(f, up); r /= np.linalg.norm(r)
    u = np.cross(r, f)
    return np.stack([r, u, -f]), d   # rows: screen x, screen y, depth (toward camera)

def render(parts, colors, W=1600, H=1200, az=-35, el=28, margin=0.06, light=(0.4, -0.6, 0.8), alpha_of=None, ss=2):
    R, d = view_matrix(az, el)
    allv = np.concatenate([p[0].reshape(-1, 3) for p in parts])
    pv = allv @ R.T
    lo, hi = pv.min(0), pv.max(0)
    Ws, Hs = W * ss, H * ss
    scale = min((Ws * (1 - 2 * margin)) / (hi[0] - lo[0]), (Hs * (1 - 2 * margin)) / (hi[1] - lo[1]))
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    zbuf = np.full((Hs, Ws), -1e18); img = np.ones((Hs, Ws, 3))
    L = np.array(light, float); L /= np.linalg.norm(L)
    Lv = L @ R.T
    trans = []
    for tris, mat, name in parts:
        col = colors.get(mat, np.array([0.7, 0.7, 0.7]))
        a = alpha_of(mat) if alpha_of else 1.0
        (trans if a < 0.99 else [None]).__class__  # noqa
        P = tris @ R.T
        X = (P[..., 0] - cx) * scale + Ws / 2; Y = Hs / 2 - (P[..., 1] - cy) * scale; Z = P[..., 2]
        n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
        nn = np.linalg.norm(n, axis=1) + 1e-12; n = n / nn[:, None]
        n[n[:, 2] < 0] *= -1   # face the camera (two-sided)
        diff = np.clip(n @ Lv, 0, 1)
        h = (Lv + np.array([0, 0, 1.0])); h /= np.linalg.norm(h)
        spec = np.clip(n @ h, 0, 1) ** 40
        shade = 0.38 + 0.62 * diff
        for i in range(len(tris)):
            xs, ys, zs = X[i], Y[i], Z[i]
            x0, x1 = int(max(0, np.floor(xs.min()))), int(min(Ws - 1, np.ceil(xs.max())))
            y0, y1 = int(max(0, np.floor(ys.min()))), int(min(Hs - 1, np.ceil(ys.max())))
            if x1 < x0 or y1 < y0: continue
            gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            (ax, bx, cx_), (ay, by, cy_) = xs, ys
            den = (by - cy_) * (ax - cx_) + (cx_ - bx) * (ay - cy_)
            if abs(den) < 1e-12: continue
            w0 = ((by - cy_) * (gx - cx_) + (cx_ - bx) * (gy - cy_)) / den
            w1 = ((cy_ - ay) * (gx - cx_) + (ax - cx_) * (gy - cy_)) / den
            w2 = 1 - w0 - w1
            m = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
            if not m.any(): continue
            z = w0 * zs[0] + w1 * zs[1] + w2 * zs[2]
            zb = zbuf[y0:y1 + 1, x0:x1 + 1]
            upd = m & (z > zb)
            if not upd.any(): continue
            c = np.clip(col * shade[i] + spec[i] * 0.35, 0, 1)
            if a < 0.99:
                cur = img[y0:y1 + 1, x0:x1 + 1]
                cur[upd] = cur[upd] * (1 - a) + c * a
            else:
                zb[upd] = z[upd]
                img[y0:y1 + 1, x0:x1 + 1][upd] = c
    im = Image.fromarray((img * 255).astype(np.uint8))
    if ss > 1: im = im.resize((W, H), Image.LANCZOS)
    return im
