using System.IO;
using System.Reflection;
using Newtonsoft.Json.Linq;

namespace RevitMCPCommandSet.Services.Fmc
{
    /// <summary>
    /// Optional GPU sampling. Formcraft.Gpu.dll is not part of the build.
    /// If it sits beside this assembly and exposes Formcraft.Gpu.Sampler.Run(string), it is called.
    /// Any failure, or a missing DLL, uses the CPU kernel in <see cref="FmcHwKernels"/>.
    /// The add-in does not reference ComputeSharp, DirectML or ONNX Runtime.
    /// </summary>
    internal static class FmcHwGpuHost
    {
        internal static JObject Try(string kind, JToken payload, JToken cpuResult)
        {
            try
            {
                string dir = Path.GetDirectoryName(typeof(FmcHwGpuHost).Assembly.Location) ?? "";
                string dll = Path.Combine(dir, "Formcraft.Gpu.dll");
                if (!File.Exists(dll))
                {
                    return Cpu(kind, cpuResult, "Formcraft.Gpu.dll is not beside the add-in. The CPU kernel ran.");
                }
                Assembly asm = Assembly.LoadFrom(dll);
                MethodInfo run = asm.GetType("Formcraft.Gpu.Sampler")?.GetMethod("Run", BindingFlags.Public | BindingFlags.Static);
                if (run == null) return Cpu(kind, cpuResult, "Formcraft.Gpu.Sampler.Run was not found. The CPU kernel ran.");
                string answer = run.Invoke(null, new object[] { kind, payload?.ToString(Newtonsoft.Json.Formatting.None) ?? "{}" }) as string;
                if (string.IsNullOrWhiteSpace(answer)) return Cpu(kind, cpuResult, "The GPU library returned nothing. The CPU kernel ran.");
                var parsed = JToken.Parse(answer);
                if (!JToken.DeepEquals(parsed, cpuResult))
                {
                    return Cpu(kind, cpuResult, "The GPU library did not match the CPU kernel. The GPU numbers were discarded.");
                }
                return new JObject
                {
                    ["kind"] = kind,
                    ["backend"] = "directcompute",
                    ["moved_to_gpu"] = true,
                    ["fallback"] = null,
                    ["result"] = parsed,
                };
            }
            catch (Exception ex)
            {
                return Cpu(kind, cpuResult, "The optional GPU library failed (" + ex.Message + "). The CPU kernel ran.");
            }
        }

        private static JObject Cpu(string kind, JToken result, string fallback)
        {
            return new JObject
            {
                ["kind"] = kind,
                ["backend"] = "cpu",
                ["moved_to_gpu"] = false,
                ["fallback"] = fallback,
                ["result"] = result,
            };
        }
    }

    /// <summary>The same numeric kernels the server tests. Plugin-side only. Not the Revit database.</summary>
    internal static class FmcHwKernels
    {
        internal static JArray Clash(JArray boxes)
        {
            var hits = new JArray();
            var list = Boxes(boxes);
            for (int i = 0; i < list.Count; i++)
            {
                for (int j = i + 1; j < list.Count; j++)
                {
                    if (Overlap(list[i], list[j])) hits.Add(new JArray(i, j));
                }
            }
            return hits;
        }

        internal static int RayHits(JArray rays, JArray boxes)
        {
            var list = Boxes(boxes);
            int hits = 0;
            foreach (JToken ray in rays ?? new JArray())
            {
                double[] origin = Vec(ray["origin"] as JArray);
                double[] direction = Vec(ray["direction"] as JArray);
                if (origin == null || direction == null) continue;
                foreach (double[] box in list) if (Ray(origin, direction, box)) hits++;
            }
            return hits;
        }

        private static List<double[]> Boxes(JArray boxes)
        {
            var list = new List<double[]>();
            foreach (JToken token in boxes ?? new JArray())
            {
                if (token is JArray row && row.Count >= 6)
                {
                    var box = new double[6];
                    for (int i = 0; i < 6; i++) box[i] = row[i].Value<double>();
                    list.Add(box);
                }
            }
            return list;
        }

        private static double[] Vec(JArray row)
        {
            if (row == null || row.Count < 3) return null;
            return new[] { row[0].Value<double>(), row[1].Value<double>(), row[2].Value<double>() };
        }

        private static bool Overlap(double[] a, double[] b)
        {
            return a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2];
        }

        private static bool Ray(double[] origin, double[] direction, double[] box)
        {
            double tmin = 0;
            double tmax = double.PositiveInfinity;
            for (int i = 0; i < 3; i++)
            {
                double min = box[i];
                double max = box[i + 3];
                double o = origin[i];
                double d = direction[i];
                if (Math.Abs(d) < 1e-12)
                {
                    if (o < min || o > max) return false;
                    continue;
                }
                double t1 = (min - o) / d;
                double t2 = (max - o) / d;
                if (t1 > t2) { double swap = t1; t1 = t2; t2 = swap; }
                tmin = Math.Max(tmin, t1);
                tmax = Math.Min(tmax, t2);
                if (tmin > tmax) return false;
            }
            return tmax >= 0;
        }
    }
}
