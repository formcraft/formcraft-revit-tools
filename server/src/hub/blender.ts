/**
 * The hub's Blender connector (owner 27 Oct: "Revit's render engine is not good"). Blender runs the Blender Lab MCP
 * add-on, which listens on localhost:9876 and runs Python. The server sends only its own fixed scripts below, with the
 * job's values as JSON (never code from the AI), so a render does exactly what the tool says.
 * Protocol: one JSON request {type: "execute", code, strict_json} ended by "\0"; one JSON answer ended by "\0".
 */
import net from "node:net";

export const BLENDER_HOST = "127.0.0.1";
export const blenderPort = (env: NodeJS.ProcessEnv = process.env) => Number(env.BLENDER_MCP_PORT) || 9876;

export interface BlenderAnswer { status?: string; message?: string; stdout?: string; stderr?: string; result?: unknown }

/** Runs one script in the open Blender and returns its answer (status ok|error, stdout). */
export function blenderRun(code: string, timeoutMs = 20 * 60000, port = blenderPort()): Promise<BlenderAnswer> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: BLENDER_HOST, port });
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (e: Error | null, a?: BlenderAnswer) => { if (done) return; done = true; sock.destroy(); e ? reject(e) : resolve(a!); };
    sock.setTimeout(timeoutMs, () => finish(new Error(`Blender didn't answer within ${Math.round(timeoutMs / 1000)} s`)));
    sock.on("connect", () => sock.write(JSON.stringify({ type: "execute", code, strict_json: false }) + "\0"));
    sock.on("data", (d) => {
      chunks.push(d);
      if (d.includes(0)) {
        const all = Buffer.concat(chunks), end = all.indexOf(0);
        try { finish(null, JSON.parse(all.subarray(0, end).toString("utf8"))); } catch (e) { finish(new Error(`Blender's answer isn't JSON: ${String(e)}`)); }
      }
    });
    sock.on("error", (e: NodeJS.ErrnoException) => finish(new Error(e.code === "ECONNREFUSED"
      ? `Blender isn't listening on localhost:${port}. Open Blender and start the MCP add-on (Preferences › Add-ons › MCP › Start MCP Bridge Server).`
      : `Blender: ${e.message}`)));
    sock.on("close", () => finish(new Error("Blender closed the connection without an answer")));
  });
}

/** The line a Formcraft script prints last: FMC_RESULT {json}. */
export function resultOf(a: BlenderAnswer): any {
  if (a.status !== "ok") throw new Error(`Blender: ${a.message ?? "the script failed"}${a.stderr ? ` (${a.stderr.slice(-600)})` : ""}`);
  const line = (a.stdout ?? "").split(/\r?\n/).reverse().find((l) => l.startsWith("FMC_RESULT "));
  if (!line) throw new Error(`Blender ran the script but gave no result${a.stdout ? `: ${a.stdout.slice(-600)}` : ""}`);
  return JSON.parse(line.slice("FMC_RESULT ".length));
}

/** A fixed script with its values: they travel as base64 JSON, so no value can become code. */
export function withValues(script: string, values: object): string {
  return `import json, base64\nP = json.loads(base64.b64decode("${Buffer.from(JSON.stringify(values)).toString("base64")}").decode("utf-8"))\n${script}`;
}

export const STATUS_SCRIPT = String.raw`
import bpy
prefs = bpy.context.preferences.addons["cycles"].preferences
devices = []
for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
    try:
        prefs.compute_device_type = kind
        prefs.get_devices()
        devices += [kind + ": " + d.name for d in prefs.devices if d.type == kind]
    except Exception:
        pass
print("FMC_RESULT " + json.dumps({"blender": bpy.app.version_string, "file": bpy.data.filepath or "(unsaved)",
    "scenes": [s.name for s in bpy.data.scenes], "gpu": devices}))
`;

/**
 * The render job. P: fbx, json (the Revit export's facts), scene (the Blender scene's name), out (png), blend (a copy
 * of the .blend, or ""), samples, width, height, camera (aerial_front|aerial_back|aerial_left|aerial_right|front|
 * revit_view), elevation_deg, azimuth_deg, lens_mm, ground, sun_elevation_deg, sun_azimuth_deg.
 * A new scene each time (the person's own scenes are left alone); Revit's materials become Formcraft Blender materials
 * by name and class (glass, metal, wood, concrete, brick, tile, plaster, stone, grass, water, fabric...), coloured from
 * Revit; sky and sun; Cycles on the GPU (OptiX, else CUDA), denoised.
 */
export const RENDER_SCRIPT = String.raw`
import bpy, math, os, re, time
from mathutils import Vector

t0 = time.time()
info = json.load(open(P["json"], encoding="utf-8"))
revit = {}
for m in info.get("materials", []):
    revit[m["name"].lower()] = m
    if m.get("obj_name"):
        revit[m["obj_name"].lower()] = m
notes = []

# ---- a fresh scene, shown in the window
old = bpy.data.scenes.get(P["scene"])
if old:
    for o in list(old.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.scenes.remove(old)
scn = bpy.data.scenes.new(P["scene"])
win = bpy.context.window_manager.windows[0] if bpy.context.window_manager.windows else None
if win:
    win.scene = scn
scn.unit_settings.system = "METRIC"

before = set(bpy.data.objects)
with bpy.context.temp_override(window=win, scene=scn) if win else bpy.context.temp_override(scene=scn):
    if P.get("obj"):
        bpy.ops.wm.obj_import(filepath=P["obj"], forward_axis="Y", up_axis="Z")
    else:
        bpy.ops.import_scene.fbx(filepath=P["fbx"], use_image_search=False)
got = [o for o in bpy.data.objects if o not in before]
for o in got:
    if o.name not in scn.collection.all_objects:
        scn.collection.objects.link(o)
for o in [o for o in got if o.type in ("CAMERA", "LIGHT")]:
    bpy.data.objects.remove(o, do_unlink=True)
got = [o for o in bpy.data.objects if o not in before]
meshes = [o for o in got if o.type == "MESH"]
if not meshes:
    raise RuntimeError("the export has no geometry (is the 3D view empty?)")

def bounds(objs):
    lo = Vector((1e18, 1e18, 1e18)); hi = -lo
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
    return lo, hi

# ---- units: the OBJ is in metres; Revit's FBX unit isn't stated; pick the scale that makes the model the size Revit says it is
ex = info["extent_mm"]
rlo = Vector([v / 1000 for v in ex["min"]]); rhi = Vector([v / 1000 for v in ex["max"]])
lo, hi = bounds(meshes)
size = max(hi - lo)
want = max(rhi - rlo)
scale = min((1.0, 0.001, 0.01, 0.0254, 0.3048, 0.1), key=lambda s: abs(math.log(max(size * s, 1e-9) / max(want, 1e-9))))
root = bpy.data.objects.new("FMC_Revit", None)
scn.collection.objects.link(root)
for o in got:
    if o.parent is None:
        o.parent = root
root.scale = (scale, scale, scale)
scn.view_layers[0].update()
lo, hi = bounds(meshes)
# the building sits where Revit has it; if the FBX was moved, put its centre on Revit's
dc = (rlo + rhi) / 2 - (lo + hi) / 2
if max(abs(dc.x), abs(dc.y)) > max(rhi - rlo) * 0.5:
    root.location = (dc.x, dc.y, (rlo.z - lo.z))
    scn.view_layers[0].update(); lo, hi = bounds(meshes)
    notes.append("moved the import onto Revit's coordinates")

# ---- Formcraft materials, by name and class, coloured from Revit
def lin(v):
    # Revit's colours are sRGB (screen) values; Blender's Base Color wants linear light
    v = v / 255
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4

def rgb(m, fallback):
    c = (m or {}).get("color")
    return tuple(lin(v) for v in c) + (1,) if c else fallback

KINDS = [
    ("paint", r"paint"),
    ("glass", r"glass|glaz|window pane|mirror"), ("water", r"water|pool"), ("metal", r"metal|steel|alum|chrome|zinc|copper|brass|iron|stainless"),
    ("wood", r"wood|timber|oak|teak|mahogany|pine|walnut|plywood|veneer|bamboo"), ("brick", r"brick|block|masonry"),
    ("concrete", r"concrete|cement|screed|terrazzo"), ("stone", r"stone|granite|marble|slate|travertine|limestone|quartz"),
    ("tile", r"tile|ceramic|porcelain"), ("grass", r"grass|lawn|turf|vegetation|planting|soil|earth|site|topo"),
    ("fabric", r"fabric|textile|carpet|cushion|leather|upholster"), ("plastic", r"plastic|pvc|upvc|vinyl|rubber|acrylic"),
    ("paint", r"paint|plaster|render|gypsum|drywall|stucco|coat|finish"),
]
def kind_of(name, m):
    text = (name + " " + (m or {}).get("class", "") + " " + (m or {}).get("category", "")).lower()
    for k, rx in KINDS:
        if re.search(rx, text):
            return k
    return "default"

def noise_bump(nt, bsdf, scale_, strength):
    tex = nt.nodes.new("ShaderNodeTexNoise"); tex.inputs["Scale"].default_value = scale_
    bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = strength
    nt.links.new(tex.outputs["Fac"], bump.inputs["Height"]); nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

def setp(bsdf, key, value):
    if key in bsdf.inputs:
        bsdf.inputs[key].default_value = value

made = {}
def fmc_material(slot_name, imported):
    base = re.sub(r"\.\d{3}$", "", slot_name)
    if base in made:
        return made[base]
    m = revit.get(base.lower())
    k = kind_of(base, m)
    fallback = tuple(imported.diffuse_color) if imported else (0.8, 0.8, 0.8, 1)
    col = rgb(m, fallback)
    mat = bpy.data.materials.new("FMC " + base)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    setp(bsdf, "Base Color", col)
    rough = 1 - (m or {}).get("smoothness", 50) / 100
    setp(bsdf, "Roughness", rough)
    if k == "glass":
        setp(bsdf, "Transmission Weight", 1.0); setp(bsdf, "Roughness", 0.02); setp(bsdf, "IOR", 1.5)
        setp(bsdf, "Base Color", (0.85, 0.92, 0.95, 1))
    elif k == "water":
        setp(bsdf, "Transmission Weight", 1.0); setp(bsdf, "Roughness", 0.05); setp(bsdf, "IOR", 1.33); setp(bsdf, "Base Color", (0.55, 0.75, 0.85, 1))
    elif k == "metal":
        setp(bsdf, "Metallic", 1.0); setp(bsdf, "Roughness", 0.3)
    elif k == "wood":
        setp(bsdf, "Roughness", 0.55); noise_bump(nt, bsdf, 80, 0.08)
    elif k == "brick":
        setp(bsdf, "Roughness", 0.85)
        b = nt.nodes.new("ShaderNodeTexBrick"); b.inputs["Scale"].default_value = 12
        b.inputs["Color1"].default_value = col; b.inputs["Color2"].default_value = tuple(c * 0.8 for c in col[:3]) + (1,)
        b.inputs["Mortar"].default_value = (0.75, 0.73, 0.7, 1)
        nt.links.new(b.outputs["Color"], bsdf.inputs["Base Color"])
    elif k in ("concrete", "stone"):
        setp(bsdf, "Roughness", 0.8 if k == "concrete" else 0.45); noise_bump(nt, bsdf, 40, 0.12)
    elif k == "tile":
        setp(bsdf, "Roughness", 0.2)
    elif k == "grass":
        setp(bsdf, "Roughness", 0.9); noise_bump(nt, bsdf, 200, 0.3)
        if not m or not m.get("color"):
            setp(bsdf, "Base Color", (0.18, 0.32, 0.1, 1))
    elif k == "fabric":
        setp(bsdf, "Roughness", 0.95); setp(bsdf, "Sheen Weight", 0.5)
    elif k == "plastic":
        setp(bsdf, "Roughness", 0.35)
    elif k == "paint":
        setp(bsdf, "Roughness", 0.65)
    t = (m or {}).get("transparency", 0)
    if t and k not in ("glass", "water"):
        setp(bsdf, "Alpha", max(0.05, 1 - t / 100))
    made[base] = mat
    return mat

kinds = {}
for o in meshes:
    for s in o.material_slots:
        if s.material is not None:
            nm = fmc_material(s.material.name, s.material)
            kinds[nm.name] = kind_of(re.sub(r"\.\d{3}$", "", s.material.name), revit.get(re.sub(r"\.\d{3}$", "", s.material.name).lower()))
            s.material = nm
matched = sum(1 for n in made if n.lower() in revit)

# ---- ground, sky and sun
lo, hi = bounds(meshes)
centre = (rlo + rhi) / 2
if P.get("ground", True):
    span = max(hi.x - lo.x, hi.y - lo.y) * 8 + 100
    me = bpy.data.meshes.new("FMC_Ground")
    me.from_pydata([(-0.5, -0.5, 0), (0.5, -0.5, 0), (0.5, 0.5, 0), (-0.5, 0.5, 0)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new("FMC_Ground", me); scn.collection.objects.link(g)
    g.scale = (span, span, 1); g.location = (centre.x, centre.y, lo.z - 0.02)
    gm = bpy.data.materials.new("FMC Ground"); gm.use_nodes = True
    gb = next(n for n in gm.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    gb.inputs["Base Color"].default_value = (0.2, 0.3, 0.12, 1); gb.inputs["Roughness"].default_value = 0.95
    me.materials.append(gm)

world = bpy.data.worlds.new("FMC Sky"); scn.world = world; world.use_nodes = True
wn = world.node_tree; bg = next(n for n in wn.nodes if n.type == "BACKGROUND")
sun_el = math.radians(P.get("sun_elevation_deg", 40)); sun_az = math.radians(P.get("sun_azimuth_deg", 135))
try:
    sky = wn.nodes.new("ShaderNodeTexSky")
    for t in ("MULTIPLE_SCATTERING", "NISHITA", "SINGLE_SCATTERING", "HOSEK_WILKIE"):
        try:
            sky.sky_type = t; break
        except Exception:
            pass
    if hasattr(sky, "sun_elevation"):
        sky.sun_elevation = sun_el; sky.sun_rotation = sun_az
    wn.links.new(sky.outputs["Color"], bg.inputs["Color"]); bg.inputs["Strength"].default_value = P.get("sky_strength", 0.25)
    notes.append("sky: " + sky.sky_type.lower())
    sky_sun = bool(getattr(sky, "sun_disc", False))
except Exception as e:
    bg.inputs["Color"].default_value = (0.6, 0.75, 0.95, 1); bg.inputs["Strength"].default_value = 0.8
    notes.append("plain sky (" + str(e)[:80] + ")"); sky_sun = False
# a sun lamp only when the sky has none of its own (two suns washed the first test out)
if not sky_sun:
    sd = bpy.data.lights.new("FMC Sun", "SUN"); sd.energy = 3.0; sd.angle = math.radians(1.5)
    sun = bpy.data.objects.new("FMC Sun", sd); scn.collection.objects.link(sun)
    sun.rotation_euler = (math.pi / 2 - sun_el, 0, sun_az + math.pi / 2)
scn.view_settings.exposure = P.get("exposure", -0.3)

# ---- camera: aerial from the front (south, looking north) unless asked otherwise
cd = bpy.data.cameras.new("FMC Camera"); cd.lens = P.get("lens_mm", 35); cd.clip_end = 100000
cam = bpy.data.objects.new("FMC Camera", cd); scn.collection.objects.link(cam); scn.camera = cam
which = P.get("camera", "aerial_front")
blo, bhi = rlo, rhi
c = (blo + bhi) / 2
if which == "revit_view":
    k = info["camera"]
    cam.location = Vector([v / 1000 for v in k["eye_mm"]])
    fwd = Vector(k["forward"]); up = Vector(k["up"])
    cam.rotation_euler = fwd.to_track_quat("-Z", "Y").to_euler()
else:
    base_az = {"aerial_front": -90, "front": -90, "aerial_back": 90, "aerial_left": 180, "aerial_right": 0}.get(which, -90)
    az = math.radians(base_az + P.get("azimuth_deg", 0))
    el = math.radians(P.get("elevation_deg", 30 if which.startswith("aerial") else 5))
    radius = (bhi - blo).length / 2
    fov = 2 * math.atan(18 / cd.lens) * min(1, P["width"] / P["height"])
    dist = radius / math.sin(fov / 2) * 1.05
    look = Vector((c.x, c.y, blo.z + (bhi.z - blo.z) * 0.35))
    cam.location = look + Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el))) * dist
    cam.rotation_euler = (look - cam.location).to_track_quat("-Z", "Y").to_euler()

# ---- Cycles on the GPU
r = scn.render
r.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
device = "CPU"
for kind in ("OPTIX", "CUDA"):
    try:
        prefs.compute_device_type = kind; prefs.get_devices()
        gpus = [d for d in prefs.devices if d.type == kind]
        if gpus:
            for d in prefs.devices: d.use = d.type == kind
            device = kind; break
    except Exception:
        pass
scn.cycles.device = "GPU" if device != "CPU" else "CPU"
scn.cycles.samples = P["samples"]; scn.cycles.use_denoising = True
r.resolution_x, r.resolution_y, r.resolution_percentage = P["width"], P["height"], 100
r.image_settings.file_format = "PNG"
r.filepath = P["out"]
t1 = time.time()
with bpy.context.temp_override(window=win, scene=scn) if win else bpy.context.temp_override(scene=scn):
    bpy.ops.render.render(write_still=True, scene=scn.name)
secs = round(time.time() - t1, 1)
if P.get("blend"):
    bpy.ops.wm.save_as_mainfile(filepath=P["blend"], copy=True)

lo, hi = bounds(meshes)
print("FMC_RESULT " + json.dumps({
    "scene": scn.name, "png": P["out"], "blend": P.get("blend") or None, "device": device, "render_s": secs, "total_s": round(time.time() - t0, 1),
    "objects": len(meshes), "scale": scale, "size_m": [round(v, 2) for v in (hi - lo)], "revit_size_m": [round(v, 2) for v in (rhi - rlo)],
    "materials": len(made), "matched_to_revit": matched, "kinds": {k: list(kinds.values()).count(k) for k in sorted(set(kinds.values()))},
    "camera": which, "notes": notes}))
`;
