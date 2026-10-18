using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Rhino.Geometry;

namespace Formcraft.Rhino
{
    /// <summary>
    /// A shaded picture of a family's parts, drawn by the bridge itself (no Rhino viewport, so the person's window and
    /// drawing are never touched): render meshes, two lights, a soft highlight per material, outlines at silhouettes and
    /// creases, drawn at twice the size and scaled down for smooth edges. For the catalogue and the check, not a
    /// photoreal render: the family's own renders come from Revit.
    /// </summary>
    public static class RhinoRender
    {
        struct Look { public Color C; public double Ks, Shine; }

        /// <summary>A plain colour for a kit material name, read from words in it (steel, white, rubber, glass, …).</summary>
        public static Color ColourOf(string material) => LookOf(material).C;

        static Look LookOf(string material)
        {
            string m = (material ?? "").ToLowerInvariant();
            bool Has(params string[] w) { foreach (string x in w) if (m.Contains(x)) return true; return false; }
            if (Has("glass", "acrylic", "polycarbonate", "clear")) return new Look { C = Color.FromArgb(178, 206, 222), Ks = 0.8, Shine = 90 };
            if (Has("chrome", "stainless", "steel", "alumin", "metal", "brushed")) return new Look { C = Color.FromArgb(186, 190, 196), Ks = 0.65, Shine = 55 };
            if (Has("black", "rubber", "elastomer")) return new Look { C = Color.FromArgb(48, 49, 52), Ks = 0.2, Shine = 14 };
            if (Has("blue")) return new Look { C = Color.FromArgb(70, 118, 172), Ks = 0.3, Shine = 30 };
            if (Has("green")) return new Look { C = Color.FromArgb(92, 150, 110), Ks = 0.3, Shine = 30 };
            if (Has("grey", "gray", "anthracite")) return new Look { C = Color.FromArgb(132, 135, 140), Ks = 0.3, Shine = 28 };
            if (Has("wood", "oak", "beech")) return new Look { C = Color.FromArgb(176, 132, 88), Ks = 0.15, Shine = 16 };
            if (Has("vinyl", "fabric", "mattress", "foam")) return new Look { C = Color.FromArgb(96, 128, 156), Ks = 0.15, Shine = 12 };
            if (Has("white", "plastic", "abs", "powder", "paint")) return new Look { C = Color.FromArgb(234, 234, 230), Ks = 0.3, Shine = 32 };
            return new Look { C = Color.FromArgb(204, 204, 204), Ks = 0.25, Shine = 24 };
        }

        public static void ToPng(IList<Part> parts, string path, int width, int height, string view)
        {
            if (width < 64 || height < 64 || (long)width * height > 4_000_000) throw new ArgumentException("width × height must be between 64 × 64 and 4 megapixels");
            const int S = 2;
            int W = width * S, H = height * S;

            Vector3d eye; // from the object towards the viewer
            switch (view)
            {
                case "front": eye = new Vector3d(0, -1, 0); break;
                case "side": eye = new Vector3d(1, 0, 0); break;
                case "top": eye = new Vector3d(0, 0, 1); break;
                case "back_iso": eye = new Vector3d(0.7, 1, 0.65); break;
                case "iso": eye = new Vector3d(-0.7, -1, 0.65); break;
                default: throw new ArgumentException("view is iso, back_iso, front, side or top");
            }
            eye.Unitize();
            Vector3d right = Vector3d.CrossProduct(view == "top" ? Vector3d.YAxis : Vector3d.ZAxis, eye);
            if (view == "top") right = Vector3d.XAxis;
            right.Unitize();
            Vector3d up = Vector3d.CrossProduct(eye, right);
            up.Unitize();

            var meshes = new List<(Mesh m, Look look)>();
            var box = BoundingBox.Empty;
            var mp = MeshingParameters.QualityRenderMesh;
            foreach (Part x in parts)
            {
                var all = new Mesh();
                foreach (Mesh m in Mesh.CreateFromBrep(x.Brep, mp) ?? new Mesh[0]) all.Append(m);
                if (all.Faces.Count == 0) continue;
                all.Faces.ConvertQuadsToTriangles();
                all.Normals.ComputeNormals();
                meshes.Add((all, LookOf(x.Material)));
                box.Union(all.GetBoundingBox(true));
            }
            if (meshes.Count == 0) throw new InvalidOperationException("The parts gave no render mesh");

            // fit the projected box in the picture, with a margin
            double minX = double.MaxValue, maxX = double.MinValue, minY = double.MaxValue, maxY = double.MinValue;
            foreach (Point3d c in box.GetCorners())
            {
                Vector3d v = new Vector3d(c);
                double px = v * right, py = v * up;
                minX = Math.Min(minX, px); maxX = Math.Max(maxX, px); minY = Math.Min(minY, py); maxY = Math.Max(maxY, py);
            }
            double scale = 0.86 * Math.Min(W / Math.Max(maxX - minX, 1e-6), H / Math.Max(maxY - minY, 1e-6));
            double cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
            double depthJump = box.Diagonal.Length * 0.004;

            var z = new float[W * H];
            var col = new int[W * H];
            var id = new short[W * H];
            var nrm = new int[W * H];
            for (int i = 0; i < z.Length; i++) { z[i] = float.MaxValue; id[i] = -1; }

            Vector3d key = new Vector3d(-0.45, -0.75, 1.0); key.Unitize();
            Vector3d fill = new Vector3d(0.85, 0.35, 0.35); fill.Unitize();
            Vector3d half = key + eye; half.Unitize();

            for (short mi = 0; mi < meshes.Count; mi++)
            {
                Mesh m = meshes[mi].m;
                Look look = meshes[mi].look;
                int n = m.Vertices.Count;
                var sx = new double[n]; var sy = new double[n]; var sz = new double[n];
                for (int i = 0; i < n; i++)
                {
                    Vector3d v = new Vector3d(m.Vertices[i]);
                    sx[i] = W / 2.0 + (v * right - cx) * scale;
                    sy[i] = H / 2.0 - (v * up - cy) * scale;
                    sz[i] = -(v * eye);
                }
                foreach (MeshFace f in m.Faces)
                {
                    int a = f.A, b = f.B, c = f.C;
                    double area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a]);
                    if (Math.Abs(area) < 1e-9) continue;
                    int x0 = Math.Max(0, (int)Math.Floor(Math.Min(sx[a], Math.Min(sx[b], sx[c])))), x1 = Math.Min(W - 1, (int)Math.Ceiling(Math.Max(sx[a], Math.Max(sx[b], sx[c]))));
                    int y0 = Math.Max(0, (int)Math.Floor(Math.Min(sy[a], Math.Min(sy[b], sy[c])))), y1 = Math.Min(H - 1, (int)Math.Ceiling(Math.Max(sy[a], Math.Max(sy[b], sy[c]))));
                    Vector3f na = m.Normals[a], nb = m.Normals[b], nc = m.Normals[c];
                    for (int py = y0; py <= y1; py++)
                    {
                        double fy = py + 0.5;
                        for (int px = x0; px <= x1; px++)
                        {
                            double fx = px + 0.5;
                            double w0 = ((sx[b] - fx) * (sy[c] - fy) - (sx[c] - fx) * (sy[b] - fy)) / area;
                            double w1 = ((sx[c] - fx) * (sy[a] - fy) - (sx[a] - fx) * (sy[c] - fy)) / area;
                            double w2 = 1 - w0 - w1;
                            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
                            float depth = (float)(w0 * sz[a] + w1 * sz[b] + w2 * sz[c]);
                            int k = py * W + px;
                            if (depth >= z[k]) continue;
                            var nv = new Vector3d(w0 * na.X + w1 * nb.X + w2 * nc.X, w0 * na.Y + w1 * nb.Y + w2 * nc.Y, w0 * na.Z + w1 * nb.Z + w2 * nc.Z);
                            if (!nv.Unitize()) continue;
                            if (nv * eye < 0) nv.Reverse();
                            double dif = Math.Max(0, nv * key) * 0.72 + Math.Max(0, nv * fill) * 0.22;
                            double amb = 0.24 + (nv.Z * 0.5 + 0.5) * 0.10;
                            double spec = look.Ks * Math.Pow(Math.Max(0, nv * half), look.Shine);
                            double rim = Math.Pow(1 - Math.Max(0, nv * eye), 3) * 0.08;
                            double lit = amb + dif + rim;
                            int r = Clamp(look.C.R * lit + 255 * spec), g = Clamp(look.C.G * lit + 255 * spec), bl = Clamp(look.C.B * lit + 255 * spec);
                            z[k] = depth; col[k] = (r << 16) | (g << 8) | bl; id[k] = mi;
                            nrm[k] = Pack(nv);
                        }
                    }
                }
            }

            // outlines: where the part changes, the depth jumps, or the surface turns sharply
            var outCol = new int[W * H];
            for (int py = 0; py < H; py++)
                for (int px = 0; px < W; px++)
                {
                    int k = py * W + px;
                    int bg = Background(py, H);
                    if (id[k] < 0)
                    {
                        bool touches = (px + 1 < W && id[k + 1] >= 0) || (py + 1 < H && id[k + W] >= 0) || (px > 0 && id[k - 1] >= 0) || (py > 0 && id[k - W] >= 0);
                        outCol[k] = touches ? Blend(bg, 0x3A3D42, 0.85) : bg;
                        continue;
                    }
                    bool edge = false;
                    foreach (int q in new[] { px + 1 < W ? k + 1 : -1, py + 1 < H ? k + W : -1 })
                    {
                        if (q < 0) continue;
                        if (id[q] < 0) { edge = true; break; }
                        if (id[q] != id[k] || Math.Abs(z[q] - z[k]) > depthJump || Dot(nrm[q], nrm[k]) < 0.82) { edge = true; break; }
                    }
                    outCol[k] = edge ? Blend(col[k], 0x3A3D42, 0.7) : col[k];
                }

            using (var bmp = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                var data = bmp.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
                var row = new byte[data.Stride];
                for (int y = 0; y < height; y++)
                {
                    for (int x = 0; x < width; x++)
                    {
                        int r = 0, g = 0, b = 0;
                        for (int j = 0; j < S; j++)
                            for (int i = 0; i < S; i++)
                            {
                                int c = outCol[(y * S + j) * W + x * S + i];
                                r += (c >> 16) & 255; g += (c >> 8) & 255; b += c & 255;
                            }
                        row[x * 3] = (byte)(b / (S * S)); row[x * 3 + 1] = (byte)(g / (S * S)); row[x * 3 + 2] = (byte)(r / (S * S));
                    }
                    Marshal.Copy(row, 0, data.Scan0 + y * data.Stride, data.Stride);
                }
                bmp.UnlockBits(data);
                string tmp = path + ".tmp";
                bmp.Save(tmp, ImageFormat.Png);
                if (System.IO.File.Exists(path)) System.IO.File.Delete(path);
                System.IO.File.Move(tmp, path);
            }
        }

        static int Background(int y, int h)
        {
            int v = 252 - (int)(14.0 * y / h);
            return (v << 16) | (v << 8) | Math.Min(255, v + 2);
        }

        static int Clamp(double v) => v < 0 ? 0 : v > 255 ? 255 : (int)v;

        static int Blend(int c, int ink, double t)
        {
            int r = (int)(((c >> 16) & 255) * (1 - t) + ((ink >> 16) & 255) * t);
            int g = (int)(((c >> 8) & 255) * (1 - t) + ((ink >> 8) & 255) * t);
            int b = (int)((c & 255) * (1 - t) + (ink & 255) * t);
            return (r << 16) | (g << 8) | b;
        }

        static int Pack(Vector3d n) => ((int)Math.Round(n.X * 127) + 128) << 16 | ((int)Math.Round(n.Y * 127) + 128) << 8 | ((int)Math.Round(n.Z * 127) + 128);

        static double Dot(int p, int q)
        {
            double ax = (((p >> 16) & 255) - 128) / 127.0, ay = (((p >> 8) & 255) - 128) / 127.0, az = ((p & 255) - 128) / 127.0;
            double bx = (((q >> 16) & 255) - 128) / 127.0, by = (((q >> 8) & 255) - 128) / 127.0, bz = ((q & 255) - 128) / 127.0;
            return ax * bx + ay * by + az * bz;
        }
    }
}
