"""KISIC 4K procedural textures (seamless, 4096 px albedo + bump). Run: python3 gen.py <outdir> [names...]"""
import sys, os, numpy as np
from PIL import Image
N = 4096
rng = np.random.default_rng(7)

def fnoise(n=N, scale=8, octaves=5, seed=0, aniso=(1, 1)):
    """tileable fractal noise via random-phase spectrum (periodic by construction)"""
    r = np.random.default_rng(seed)
    fy = np.fft.fftfreq(n)[:, None] * n / aniso[1]
    fx = np.fft.rfftfreq(n)[None, :] * n / aniso[0]
    f = np.sqrt(fx ** 2 + fy ** 2); f[0, 0] = 1
    amp = 1 / (f ** 1.6); amp[f < scale * 0.5] *= 0.15; amp[0, 0] = 0
    amp[f > scale * 2 ** octaves] = 0
    spec = amp * np.exp(2j * np.pi * r.random(amp.shape))
    out = np.fft.irfft2(spec, s=(n, n)).astype(np.float32)
    out -= out.min(); out /= out.max(); return out

def save(out, name, alb, bump):
    a = np.clip(alb, 0, 255).astype(np.uint8)
    Image.fromarray(a).save(os.path.join(out, f"KISIC4K_{name}_albedo.jpg"), quality=90, optimize=True)
    b = bump - bump.min(); b = (b / max(b.max(), 1e-6) * 255).astype(np.uint8)
    Image.fromarray(b).save(os.path.join(out, f"KISIC4K_{name}_bump.jpg"), quality=88, optimize=True)
    print("saved", name, flush=True)

def tint(gray, c0, c1):
    g = gray[..., None]; return np.array(c0) * (1 - g) + np.array(c1) * g

yy, xx = np.mgrid[0:N, 0:N].astype(np.float32) / N

def mvule():  # 800 mm square: straight-grained African teak, 4 boards across, grain along y
    d = xx * N + (fnoise(scale=2, seed=1, aniso=(1, 1/8)) - 0.5) * 160 + (fnoise(scale=10, seed=2, aniso=(1, 1/25)) - 0.5) * 30
    ring = 0.5 + 0.5 * np.sin(2 * np.pi * d / 13.0)
    pores = fnoise(scale=700, seed=3, aniso=(1, 1/40))
    board = np.floor(xx * 4); tone = ((board * 0.618) % 1 - 0.5) * 0.12
    g = 0.42 + 0.22 * ring ** 3 + 0.22 * (pores - 0.5) + 0.18 * (fnoise(scale=3, seed=4, aniso=(1, 1/6)) - 0.5) + tone
    joint = (np.abs((xx * 4) % 1) < 0.002)
    alb = tint(np.clip(g, 0, 1), (88, 54, 28), (176, 124, 74)); alb[joint] *= 0.45
    save(OUT, "Timber_Mvule", alb, ring * 0.5 + pores * 0.5 - joint * 0.8)

def barkcloth():  # Ugandan lubugo: beaten fig bark, fibrous streaks, hammer marks, terracotta-brown
    streak = fnoise(scale=40, seed=11, aniso=(1, 25))
    blotch = fnoise(scale=3, seed=12); hammer = fnoise(scale=90, seed=13, aniso=(3, 1))
    g = 0.5 + 0.35 * (streak - 0.5) + 0.3 * (blotch - 0.5) + 0.12 * (hammer - 0.5)
    alb = tint(np.clip(g, 0, 1), (104, 52, 26), (196, 118, 66))
    save(OUT, "Fabric_BarkCloth", alb, streak * 0.7 + hammer * 0.3)

def weave(name, c0, c1, period=64, strand=0.8, seed=21):  # basket / banana-fibre / linen weave
    u = (xx * N / period) % 2; v = (yy * N / period) % 2
    over = ((np.floor(u) + np.floor(v)) % 2).astype(np.float32)
    su = np.sin(np.pi * (xx * N / period % 1)) ** strand; sv = np.sin(np.pi * (yy * N / period % 1)) ** strand
    h = np.where(over > 0, sv, su); fib = fnoise(scale=200, seed=seed, aniso=(1, 4))
    g = 0.35 + 0.5 * h + 0.2 * (fib - 0.5) + 0.12 * (fnoise(scale=5, seed=seed + 1) - 0.5)
    alb = tint(np.clip(g, 0, 1), c0, c1)
    save(OUT, name, alb, h * 0.8 + fib * 0.2)

def tiles(name, n_tiles, base0, base1, grout, gw=0.004, seed=31, speck=0.0):
    u = (xx * n_tiles) % 1; v = (yy * n_tiles) % 1
    gm = (u < gw * n_tiles) | (v < gw * n_tiles)
    tid = (np.floor(xx * n_tiles) * 7 + np.floor(yy * n_tiles) * 13) % 5
    g = 0.5 + 0.18 * (fnoise(scale=12, seed=seed) - 0.5) + 0.08 * (fnoise(scale=120, seed=seed + 1) - 0.5) + (tid - 2) * 0.02
    alb = tint(np.clip(g, 0, 1), base0, base1)
    if speck > 0:
        s = fnoise(scale=500, seed=seed + 2) > 1 - speck; alb[s] *= 0.82
    alb[gm] = grout
    bump = g * 0.15 + (~gm) * 1.0
    save(OUT, name, alb, bump)

def terrazzo():
    alb = np.zeros((N, N, 3), np.float32) + np.array([206, 200, 188]); alb *= (0.92 + 0.12 * fnoise(scale=6, seed=41))[..., None]
    chips = [((96, 88, 80), 900), ((176, 96, 64), 500), ((240, 236, 228), 900), ((60, 60, 58), 350), ((150, 140, 120), 700)]
    r = np.random.default_rng(42)
    for col, cnt in chips:
        for _ in range(cnt):
            cx, cy, rad = r.integers(0, N), r.integers(0, N), r.integers(6, 28)
            y0, y1, x0, x1 = cy - rad, cy + rad, cx - rad, cx + rad
            ys, xs = np.mgrid[y0:y1, x0:x1]; d = ((xs - cx) / rad) ** 2 + ((ys - cy) / (rad * r.uniform(0.5, 1))) ** 2
            m = d < 1 - 0.3 * r.random(d.shape)
            alb[ys[m] % N, xs[m] % N] = np.array(col) * r.uniform(0.85, 1.1)
    save(OUT, "Finish_Terrazzo", alb, fnoise(scale=300, seed=43) * 0.3)

def bamboo():  # split-bamboo ceiling, strips ~25 mm on 1000 mm -> 40 strips, nodes
    s = (xx * 40) % 1; edge = np.minimum(s, 1 - s)
    off = np.random.default_rng(52).random(40)[np.floor(xx * 40).astype(int) % 40]
    node = np.abs(((yy + off) * 2.5) % 1 - 0.5) < 0.005
    g = 0.55 + 0.25 * np.sqrt(np.clip(edge * 4, 0, 1)) + 0.15 * (fnoise(scale=80, seed=51, aniso=(1, 30)) - 0.5) + ((np.floor(xx * 40) * 17) % 5 - 2) * 0.03
    alb = tint(np.clip(g, 0, 1), (150, 112, 62), (220, 184, 124)); alb[node] *= 0.7; alb[edge < 0.04] *= 0.55
    save(OUT, "Vernacular_Bamboo", alb, np.sqrt(np.clip(edge * 4, 0, 1)) - node * 0.5)

def plaster(name, c, var=0.06, seed=61):
    g = fnoise(scale=10, seed=seed) * 0.6 + fnoise(scale=300, seed=seed + 1) * 0.4
    alb = np.array(c, np.float32)[None, None, :] * (1 - var / 2 + var * g)[..., None]
    save(OUT, name, alb, g)

def leaf():
    g = fnoise(scale=60, seed=71) * 0.6 + fnoise(scale=8, seed=72) * 0.4
    veins = np.abs(np.sin((xx + yy * 0.6 + fnoise(scale=4, seed=73) * 0.05) * np.pi * 120)) < 0.08
    alb = tint(g, (30, 70, 28), (110, 160, 70)); alb[veins] *= 1.15
    save(OUT, "Plant_Leaf", alb, g + veins * 0.3)

JOBS = {
    "mvule": mvule, "bark": barkcloth,
    "banana": lambda: weave("Vernacular_BananaFibre", (120, 88, 52), (214, 178, 122), period=96, strand=0.6, seed=21),
    "linen": lambda: weave("Fabric_Linen_Olive", (74, 80, 50), (132, 140, 98), period=16, strand=1.5, seed=25),
    "porcelain": lambda: tiles("Tile_Porcelain_600", 2, (186, 178, 166), (222, 216, 204), (150, 146, 140), gw=0.0015, seed=31, speck=0.002),
    "quarry": lambda: tiles("Tile_Quarry_200", 4, (140, 62, 34), (190, 96, 56), (120, 112, 102), gw=0.002, seed=35),
    "terrazzo": terrazzo, "bamboo": bamboo,
    "paint": lambda: plaster("Paint_Linen_White", (241, 235, 223), 0.04, 61),
    "terracotta": lambda: plaster("Paint_Clay_Terracotta", (178, 100, 66), 0.10, 63),
    "render": lambda: plaster("Render_Sand", (226, 212, 186), 0.14, 65),
    "leaf": leaf,
}
if __name__ == "__main__":
    OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
    for k in (sys.argv[2:] or JOBS):
        JOBS[k]()
