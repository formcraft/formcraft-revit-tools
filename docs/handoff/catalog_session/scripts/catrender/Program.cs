// Formcraft catalogue renderer: the look of RhinoRender.cs (connectors/rhino), standalone and finer.
// Reads a catalogue mesh (from Revit: triangles in mm with each material's colour, transparency, shininess) and writes
// a PNG: white-to-grey background, three-point light, specular, soft outlines, glass laid over, a soft ground shadow,
// ambient occlusion from the depth buffer, 3x3 supersampling. usage: catrender <mesh.json> <out.png> [iso|back_iso|front] [width] [height]
using System.IO.Compression;
using System.Numerics;
using System.Text.Json;

var a = args;
var doc = JsonDocument.Parse(File.ReadAllText(a[0]));
string view = a.Length > 2 ? a[2] : "iso";
bool hang = a.Contains("--hang");
bool white = a.Contains("--white");
int width = a.Length > 3 ? int.Parse(a[3]) : 2000, height = a.Length > 4 ? int.Parse(a[4]) : 1500;
const int S = 3;
int W = width * S, H = height * S;

Vector3 eye = view switch { "front" => new(0, -1, 0.0f), "back_iso" => new(0.7f, 1, 0.65f), _ => new(-0.7f, -1, 0.65f) };
// a ceiling-hung family: turned the right way down and seen from a little below, as it hangs
if (hang && view != "front") eye = new(eye.X, eye.Y, -0.35f);
eye = Vector3.Normalize(eye);
Vector3 right = Vector3.Normalize(Vector3.Cross(Vector3.UnitZ, eye));
Vector3 up = Vector3.Normalize(Vector3.Cross(eye, right));

var parts = new List<(Vector3[] v, Vector3 c, float alpha, float ks, float shine)>();
Vector3 lo = new(float.MaxValue), hi = new(float.MinValue);
foreach (var p in doc.RootElement.GetProperty("parts").EnumerateArray())
{
    var vs = p.GetProperty("v").EnumerateArray().Select(x => (float)x.GetDouble()).ToArray();
    var v = new Vector3[vs.Length / 3];
    for (int i = 0; i < v.Length; i++) { v[i] = new(vs[3 * i], hang ? -vs[3 * i + 1] : vs[3 * i + 1], hang ? -vs[3 * i + 2] : vs[3 * i + 2]); lo = Vector3.Min(lo, v[i]); hi = Vector3.Max(hi, v[i]); }
    var rgb = p.GetProperty("rgb").EnumerateArray().Select(x => x.GetInt32()).ToArray();
    string name = p.GetProperty("name").GetString() ?? "";
    float alpha = (float)p.GetProperty("alpha").GetDouble(), shine = (float)p.GetProperty("shine").GetDouble();
    var c = new Vector3(rgb[0], rgb[1], rgb[2]);
    string n = name.ToLowerInvariant();
    bool glass = n.Contains("glass") || n.Contains("glazing") || n.Contains("acrylic") || n.Contains("polycarbonate");
    if (glass) { alpha = Math.Min(alpha, 0.2f); c = new(200, 222, 232); }
    bool metal = n.Contains("steel") || n.Contains("stainless") || n.Contains("chrome") || n.Contains("alumin") || n.Contains("metal");
    float ks = glass ? 0.9f : metal ? 0.6f : 0.28f;
    float sh = glass ? 120 : metal ? 55 : Math.Clamp(shine / 2 + 12, 10, 60);
    parts.Add((v, c, alpha, ks, sh));
}

// fit the projected box with a margin; the ground is the lowest point
float minX = float.MaxValue, maxX = float.MinValue, minY = float.MaxValue, maxY = float.MinValue;
foreach (var cx_ in new[] { lo.X, hi.X }) foreach (var cy_ in new[] { lo.Y, hi.Y }) foreach (var cz_ in new[] { lo.Z, hi.Z })
{
    var q = new Vector3(cx_, cy_, cz_);
    float px = Vector3.Dot(q, right), py = Vector3.Dot(q, up);
    minX = Math.Min(minX, px); maxX = Math.Max(maxX, px); minY = Math.Min(minY, py); maxY = Math.Max(maxY, py);
}
// room below for the ground shadow
minY -= (maxY - minY) * 0.04f;
float scale = 0.82f * Math.Min(W / Math.Max(maxX - minX, 1e-3f), H / Math.Max(maxY - minY, 1e-3f));
float ccx = (minX + maxX) / 2, ccy = (minY + maxY) / 2;
float diag = (hi - lo).Length();

var z = new float[W * H]; var col = new Vector3[W * H]; var id = new short[W * H]; var nrm = new Vector3[W * H];
Array.Fill(z, float.MaxValue); Array.Fill(id, (short)-1);
Vector3 key = Vector3.Normalize(new(-0.45f, -0.75f, 1.0f)), fill = Vector3.Normalize(new(0.85f, 0.35f, 0.35f));
Vector3 half = Vector3.Normalize(key + eye);

(float x, float y, float d) Proj(Vector3 v) => (W / 2f + (Vector3.Dot(v, right) - ccx) * scale, H / 2f - (Vector3.Dot(v, up) - ccy) * scale, -Vector3.Dot(v, eye));

void Raster(Vector3[] v, Action<int, float, Vector3> plot)
{
    for (int t = 0; t + 2 < v.Length; t += 3)
    {
        var (ax, ay, ad) = Proj(v[t]); var (bx, by, bd) = Proj(v[t + 1]); var (cx, cy, cd) = Proj(v[t + 2]);
        float area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
        if (Math.Abs(area) < 1e-6f) continue;
        Vector3 nf = Vector3.Cross(v[t + 1] - v[t], v[t + 2] - v[t]);
        if (nf.LengthSquared() < 1e-12f) continue;
        nf = Vector3.Normalize(nf);
        if (Vector3.Dot(nf, eye) < 0) nf = -nf;
        int x0 = Math.Max(0, (int)MathF.Floor(MathF.Min(ax, MathF.Min(bx, cx)))), x1 = Math.Min(W - 1, (int)MathF.Ceiling(MathF.Max(ax, MathF.Max(bx, cx))));
        int y0 = Math.Max(0, (int)MathF.Floor(MathF.Min(ay, MathF.Min(by, cy)))), y1 = Math.Min(H - 1, (int)MathF.Ceiling(MathF.Max(ay, MathF.Max(by, cy))));
        for (int py = y0; py <= y1; py++)
        {
            float fy = py + 0.5f;
            for (int px = x0; px <= x1; px++)
            {
                float fx = px + 0.5f;
                float w0 = ((bx - fx) * (cy - fy) - (cx - fx) * (by - fy)) / area;
                float w1 = ((cx - fx) * (ay - fy) - (ax - fx) * (cy - fy)) / area;
                float w2 = 1 - w0 - w1;
                if (w0 < -1e-5f || w1 < -1e-5f || w2 < -1e-5f) continue;
                plot(py * W + px, w0 * ad + w1 * bd + w2 * cd, nf);
            }
        }
    }
}

Vector3 Shade((Vector3[] v, Vector3 c, float alpha, float ks, float shine) p, Vector3 n)
{
    float dif = MathF.Max(0, Vector3.Dot(n, key)) * 0.70f + MathF.Max(0, Vector3.Dot(n, fill)) * 0.22f;
    float amb = 0.26f + (n.Z * 0.5f + 0.5f) * 0.10f;
    float spec = p.ks * MathF.Pow(MathF.Max(0, Vector3.Dot(n, half)), p.shine);
    float rim = MathF.Pow(1 - MathF.Max(0, Vector3.Dot(n, eye)), 3) * 0.08f;
    float lit = amb + dif + rim;
    return Vector3.Clamp(p.c * lit + new Vector3(255 * spec), Vector3.Zero, new Vector3(255));
}

for (short i = 0; i < parts.Count; i++)
{
    var p = parts[i]; if (p.alpha < 1) continue; short own = i;
    Raster(p.v, (k, d, n) => { if (d >= z[k]) return; z[k] = d; col[k] = Shade(p, n); id[k] = own; nrm[k] = n; });
}

// ambient occlusion from the depth buffer: nearer neighbours darken a pixel a little
float aoR = 6 * S, depthScale = diag * 0.02f;
var ao = new float[W * H];
Parallel.For(0, H, py =>
{
    var offs = new (int dx, int dy)[] { (1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1) };
    for (int px = 0; px < W; px++)
    {
        int k = py * W + px; if (id[k] < 0) continue;
        float occ = 0;
        foreach (var (dx, dy) in offs)
            for (int r = 1; r <= 3; r++)
            {
                int qx = px + (int)(dx * aoR * r / 3), qy = py + (int)(dy * aoR * r / 3);
                if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
                int q = qy * W + qx; if (id[q] < 0) continue;
                float dz = z[k] - z[q];
                if (dz > 0) occ += MathF.Min(1, dz / depthScale) / r;
            }
        ao[k] = MathF.Min(0.35f, occ * 0.06f);
    }
});

// the ground shadow: every covered pixel's point dropped onto the ground plane along the key light
float ground = lo.Z;
var shadow = new float[W * H];
Vector3 inv(float sx, float sy, float d)
{
    float u = (sx - W / 2f) / scale + ccx, vv = -(sy - H / 2f) / scale + ccy;
    return right * u + up * vv - eye * d;
}
Vector3 sun = Vector3.Normalize(new(-0.25f, -0.35f, 1.0f));
for (int py = 0; py < H; py += 2)
    for (int px = 0; px < W; px += 2)
    {
        int k = py * W + px; if (id[k] < 0) continue;
        Vector3 wpt = inv(px + 0.5f, py + 0.5f, z[k]);
        float tt = (wpt.Z - ground) / sun.Z;
        Vector3 g = wpt - sun * tt;
        var (gx, gy, _) = Proj(g);
        int ix = (int)gx, iy = (int)gy;
        float strength = hang ? 0f : 0.55f * MathF.Exp(-MathF.Max(0, wpt.Z - ground) / (diag * 0.6f));
        for (int j = -2; j <= 2; j++) for (int i2 = -2; i2 <= 2; i2++)
        {
            int sx = ix + i2, sy = iy + j; if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
            int q = sy * W + sx; shadow[q] = MathF.Max(shadow[q], strength);
        }
    }
// soften the shadow (box blur, two passes)
float[] Blur(float[] src, int r)
{
    var tmp = new float[src.Length]; var dst = new float[src.Length];
    Parallel.For(0, H, y => { float s = 0; for (int x = -r; x < W; x++) { if (x + r < W) s += src[y * W + x + r]; if (x - r - 1 >= 0) s -= src[y * W + x - r - 1]; if (x >= 0) tmp[y * W + x] = s / (2 * r + 1); } });
    Parallel.For(0, W, x => { float s = 0; for (int y = -r; y < H; y++) { if (y + r < H) s += tmp[(y + r) * W + x]; if (y - r - 1 >= 0) s -= tmp[(y - r - 1) * W + x]; if (y >= 0) dst[y * W + x] = s / (2 * r + 1); } });
    return dst;
}
shadow = Blur(Blur(shadow, 9 * S), 9 * S);

Vector3 Bg(int y) { if (white) return new(255, 255, 255); float v = 253 - 15f * y / H; return new(v, v, MathF.Min(255, v + 2)); }
var outc = new Vector3[W * H];
var ink = new Vector3(58, 61, 66);
float depthJump = diag * 0.004f;
Parallel.For(0, H, py =>
{
    for (int px = 0; px < W; px++)
    {
        int k = py * W + px;
        if (id[k] < 0) { outc[k] = Bg(py) * (1 - shadow[k]); continue; }
        bool edge = false;
        foreach (int q in new[] { px + 1 < W ? k + 1 : -1, py + 1 < H ? k + W : -1 })
        {
            if (q < 0) continue;
            if (id[q] < 0 || id[q] != id[k] || MathF.Abs(z[q] - z[k]) > depthJump || Vector3.Dot(nrm[q], nrm[k]) < 0.82f) { edge = true; break; }
        }
        var c = col[k] * (1 - ao[k]);
        outc[k] = edge ? Vector3.Lerp(c, ink, 0.55f) : c;
    }
});

// glass over what is behind it
for (short i = 0; i < parts.Count; i++)
{
    var p = parts[i]; if (p.alpha >= 1) continue;
    Raster(p.v, (k, d, n) =>
    {
        if (d >= z[k]) return;
        float fres = MathF.Pow(1 - MathF.Max(0, Vector3.Dot(n, eye)), 2) * 0.45f;
        outc[k] = Vector3.Lerp(outc[k], Shade(p, n), MathF.Min(0.85f, p.alpha + fres));
    });
}

// downsample and write the PNG
var rows = new byte[height * (width * 3 + 1)];
Parallel.For(0, height, y =>
{
    int o = y * (width * 3 + 1); rows[o] = 0;
    for (int x = 0; x < width; x++)
    {
        Vector3 s = Vector3.Zero;
        for (int j = 0; j < S; j++) for (int i = 0; i < S; i++) s += outc[(y * S + j) * W + x * S + i];
        s /= S * S;
        rows[o + 1 + x * 3] = (byte)Math.Clamp(s.X, 0, 255); rows[o + 2 + x * 3] = (byte)Math.Clamp(s.Y, 0, 255); rows[o + 3 + x * 3] = (byte)Math.Clamp(s.Z, 0, 255);
    }
});
using var fs = File.Create(a[1]);
void Chunk(string type, byte[] data)
{
    var len = BitConverter.GetBytes(data.Length); Array.Reverse(len); fs.Write(len);
    var td = System.Text.Encoding.ASCII.GetBytes(type).Concat(data).ToArray(); fs.Write(td);
    uint crc = 0xFFFFFFFF; foreach (byte b in td) { crc ^= b; for (int k = 0; k < 8; k++) crc = (crc & 1) != 0 ? 0xEDB88320 ^ (crc >> 1) : crc >> 1; }
    var cb = BitConverter.GetBytes(~crc); Array.Reverse(cb); fs.Write(cb);
}
fs.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
var ihdr = new byte[13]; var wb = BitConverter.GetBytes(width); Array.Reverse(wb); var hb = BitConverter.GetBytes(height); Array.Reverse(hb);
wb.CopyTo(ihdr, 0); hb.CopyTo(ihdr, 4); ihdr[8] = 8; ihdr[9] = 2;
Chunk("IHDR", ihdr);
using (var ms = new MemoryStream()) { using (var zs = new ZLibStream(ms, CompressionLevel.Optimal, true)) zs.Write(rows); Chunk("IDAT", ms.ToArray()); }
Chunk("IEND", Array.Empty<byte>());
Console.WriteLine($"{a[1]}: {parts.Count} parts, {parts.Sum(p => p.v.Length / 3)} triangles, {view}, {width}x{height}");
