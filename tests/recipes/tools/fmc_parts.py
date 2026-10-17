"""Photo-to-family, step 3: a product described as real parts -> an fmc-recipe (Revit ops) + a shaded preview.

Coordinates in mm: x right, y back (a wall-mounted product has its back at y = 0 and stands out toward -y), z up.

Part shapes
  box    at=[x0,y0,z0,x1,y1,z1]                     rounded vertical edges with r (plan corner radius)
  fbox   at=[x0,y0,z0,x1,y1,z1]                     same, rounded in the front plane (edges seen from the front)
  prism  pts=[[x,y],...] z=[z0,z1]                  plan outline extruded up
  front  pts=[[x,z],...] y=[y0,y1]                  front outline extruded along y (y0 < y1, front is -y)
  right  pts=[[y,z],...] x=[x0,x1]                  side outline extruded along x
  cyl    axis=z c=[x,y] z=[z0,z1] r                 cylinder; axis=y c=[x,z] y=[y0,y1] r; axis=x c=[y,z] x=[x0,x1] r
  turn   axis=z c=[x,y] profile=[[r,z],...]         turned part (revolution); axis=y profile [[r,y],...]; axis=x [[r,x],...]
Common keys: n (name, unique), mat (key in materials), lod ('c','m','f' combined; default 'mf'), void (cut), repeat {n, d:[dx,dy,dz]}
"""
import os
import json, math, os, sys, copy

KIT_MATERIALS = os.environ.get('FMC_MATERIALS', '/mnt/user-data/outputs/kit/m1/FMC_Materials.json')
GUID = {'FMC_Keynote_Code': '2d089b32-0589-516b-8952-9f6afad95971', 'FMC_Cost_Unit': '6f0f6197-4d1e-5601-afd7-98d436c0bd40',
        'FMC_Geometry_Stage': '27c3be4d-9757-51ba-aa96-6c7a3a061025', 'IfcExportAs': 'bae7a5f9-3ec7-57e3-ba6b-bcd858fd95f7'}
_mat_cache = None
STAGING = os.environ.get("FMC_STAGING", r"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\04_Families\_Staging")
# Revit's own enum names for systems people write the other way round (PipeSystemType.SupplyHydronic, ...)
SYS_ALIAS = {"HydronicSupply": "SupplyHydronic", "HydronicReturn": "ReturnHydronic", "ColdWater": "DomesticColdWater", "HotWater": "DomesticHotWater"}
OPEN = {"FMC_Manufacturer": "dc399f41-0c78-566b-bf6a-94cdba78e4fa", "FMC_Model_Number": "3278e3b0-76e8-57ec-b892-1b3b75af7dce"}

KIT_ROOT = os.environ.get("FMC_KIT", "/home/claude/kitdata/FMC_Kit_v2.2")
CAT_OST = {"Medical Equipment": "OST_MedicalEquipment", "Mechanical Equipment": "OST_MechanicalEquipment", "Doors": "OST_Doors", "Windows": "OST_Windows",
           "Plumbing Fixtures": "OST_PlumbingFixtures", "Plumbing Equipment": "OST_PlumbingEquipment", "Electrical Fixtures": "OST_ElectricalFixtures",
           "Electrical Equipment": "OST_ElectricalEquipment", "Lighting Fixtures": "OST_LightingFixtures", "Lighting Devices": "OST_LightingDevices",
           "Specialty Equipment": "OST_SpecialityEquipment", "Furniture": "OST_Furniture", "Casework": "OST_Casework", "Generic Models": "OST_GenericModel",
           "Structural Foundations": "OST_StructuralFoundation", "Structural Columns": "OST_StructuralColumns", "Structural Framing": "OST_StructuralFraming",
           "Structural Connections": "OST_StructConnections", "Sprinklers": "OST_Sprinklers", "Air Terminals": "OST_DuctTerminal", "Duct Accessories": "OST_DuctAccessory",
           "Pipe Accessories": "OST_PipeAccessory", "Fire Alarm Devices": "OST_FireAlarmDevices", "Communication Devices": "OST_CommunicationDevices",
           "Data Devices": "OST_DataDevices", "Security Devices": "OST_SecurityDevices", "Nurse Call Devices": "OST_NurseCallDevices", "Site": "OST_Site", "Planting": "OST_Planting"}
TEMPLATE_CAT = {"Metric Mechanical Equipment.rft": "Mechanical Equipment", "Metric Door.rft": "Doors", "Metric Window.rft": "Windows",
                "Metric Generic Model.rft": "Generic Models", "Metric Furniture.rft": "Furniture", "Metric Casework.rft": "Casework"}
# Medical Equipment has no bindings in the kit yet (KIT_CHANGE_REQUEST 17 Oct, 2): it takes Specialty Equipment's set meanwhile
CAT_PROXY = {"OST_MedicalEquipment": "OST_SpecialityEquipment", "OST_PlumbingEquipment": "OST_PlumbingFixtures", "OST_CommunicationDevices": "OST_FireAlarmDevices",
             "OST_NurseCallDevices": "OST_FireAlarmDevices", "OST_StructConnections": "OST_StructuralFraming"}
_kit = {}
def kit_params(category):
    """Every kit shared parameter bound to the family's category (FMC_Master_Data params: guid, binding, categories)."""
    if 'p' not in _kit:
        try: _kit['p'] = json.load(open(os.path.join(KIT_ROOT, '03_Master_Data', 'FMC_Master_Data.json'), encoding='utf-8'))['params']
        except Exception: _kit['p'] = {}
    ost = CAT_OST.get(category, "OST_GenericModel"); ost = ost if any(ost in p.get('categories', []) for p in _kit['p'].values()) else CAT_PROXY.get(ost, "OST_GenericModel")
    return {n: p for n, p in _kit['p'].items() if p.get('binding') in ('Type', 'Instance') and ost in p.get('categories', [])}
def keynote_text(code):
    if 'k' not in _kit:
        _kit['k'] = {}
        try:
            for line in open(os.path.join(KIT_ROOT, '02_Keynotes', 'FMC_Keynotes.txt'), encoding='utf-8', errors='ignore'):
                c = line.rstrip('\n').split('\t')
                if len(c) >= 2: _kit['k'][c[0]] = (c[1], c[2] if len(c) > 2 else '')
        except Exception: pass
    return _kit['k'].get(code, ('', ''))

def kit_materials():
    global _mat_cache
    if _mat_cache is None:
        try: _mat_cache = {m['name']: m for m in json.load(open(KIT_MATERIALS, encoding='utf-8'))['materials']}
        except Exception: _mat_cache = {}
    return _mat_cache
def hexrgb(h):
    h = (h or '#B8C0C8').lstrip('#'); return [int(h[i:i + 2], 16) for i in (0, 2, 4)]

# ---------------------------------------------------------------- outlines
def circle(cx, cy, r, n=24): return [[round(cx + r * math.cos(2 * math.pi * k / n), 2), round(cy + r * math.sin(2 * math.pi * k / n), 2)] for k in range(n)]
def rrect(x0, y0, x1, y1, r=0, n=4):
    r = max(0, min(r, (x1 - x0) / 2 - 0.01, (y1 - y0) / 2 - 0.01))
    if r <= 0.5: return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    pts = []
    for cx, cy, a0 in ((x1 - r, y0 + r, -90), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180)):
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n); pts.append([round(cx + r * math.cos(a), 2), round(cy + r * math.sin(a), 2)])
    return pts

def expand(parts):
    out = []
    for p in parts:
        rep = p.get('repeat')
        if not rep: out.append(p); continue
        for k in range(rep['n']):
            q = copy.deepcopy(p); q.pop('repeat'); q['n'] = f"{p['n']} {k + 1}"; dx, dy, dz = rep['d']; sh = (dx * k, dy * k, dz * k)
            if 'at' in q: q['at'] = [q['at'][0] + sh[0], q['at'][1] + sh[1], q['at'][2] + sh[2], q['at'][3] + sh[0], q['at'][4] + sh[1], q['at'][5] + sh[2]]
            s = q['shape']; ax = q.get('axis', 'z')
            if s == 'prism': q['pts'] = [[a + sh[0], b + sh[1]] for a, b in q['pts']]; q['z'] = [q['z'][0] + sh[2], q['z'][1] + sh[2]]
            if s == 'front': q['pts'] = [[a + sh[0], b + sh[2]] for a, b in q['pts']]; q['y'] = [q['y'][0] + sh[1], q['y'][1] + sh[1]]
            if s == 'right': q['pts'] = [[a + sh[1], b + sh[2]] for a, b in q['pts']]; q['x'] = [q['x'][0] + sh[0], q['x'][1] + sh[0]]
            if s in ('cyl', 'turn'):
                c = q['c']
                if ax == 'z': q['c'] = [c[0] + sh[0], c[1] + sh[1]]; q['z'] = [q['z'][0] + sh[2], q['z'][1] + sh[2]] if 'z' in q else None
                if ax == 'y': q['c'] = [c[0] + sh[0], c[1] + sh[2]]; q['y'] = [q['y'][0] + sh[1], q['y'][1] + sh[1]] if 'y' in q else None
                if ax == 'x': q['c'] = [c[0] + sh[1], c[1] + sh[2]]; q['x'] = [q['x'][0] + sh[0], q['x'][1] + sh[0]] if 'x' in q else None
                if s == 'turn':
                    off = {'z': sh[2], 'y': sh[1], 'x': sh[0]}[ax]
                    q['profile'] = [[r, t + off] for r, t in q['profile']]
                for k2 in ('z', 'y', 'x'):
                    if k2 in q and q[k2] is None: q.pop(k2)
            out.append(q)
    return out

def norm(p):
    """Every part as one of: prism(plan), front, right, turn(axis); returns dict with geometry for ops and mesh."""
    s, ax = p['shape'], p.get('axis', 'z')
    if s == 'box': x0, y0, z0, x1, y1, z1 = p['at']; return dict(kind='plan', pts=rrect(x0, y0, x1, y1, p.get('r', 0)), a=z0, b=z1)
    if s == 'fbox': x0, y0, z0, x1, y1, z1 = p['at']; return dict(kind='front', pts=rrect(x0, z0, x1, z1, p.get('r', 0)), a=y0, b=y1)
    if s == 'prism': return dict(kind='plan', pts=p['pts'], a=p['z'][0], b=p['z'][1])
    if s == 'front': return dict(kind='front', pts=p['pts'], a=p['y'][0], b=p['y'][1])
    if s == 'right': return dict(kind='right', pts=p['pts'], a=p['x'][0], b=p['x'][1])
    if s == 'cyl':
        c, r = p['c'], p['r']
        if ax == 'z': return dict(kind='plan', pts=circle(c[0], c[1], r, p.get('seg', 24)), a=p['z'][0], b=p['z'][1])
        if ax == 'y': return dict(kind='front', pts=circle(c[0], c[1], r, p.get('seg', 24)), a=p['y'][0], b=p['y'][1])
        return dict(kind='right', pts=circle(c[0], c[1], r, p.get('seg', 24)), a=p['x'][0], b=p['x'][1])
    if s == 'turn': return dict(kind='turn', axis=ax, c=p['c'], profile=p['profile'])
    raise ValueError('unknown shape ' + s)

def to3d(kind, q, t):
    if kind == 'plan': return (q[0], q[1], t)
    if kind == 'front': return (q[0], t, q[1])
    return (t, q[0], q[1])

def bounds(g):
    if g['kind'] == 'turn':
        rs = [r for r, _ in g['profile']]; ts = [t for _, t in g['profile']]; R = max(rs); c = g['c']
        if g['axis'] == 'z': return (c[0] - R, c[1] - R, min(ts)), (c[0] + R, c[1] + R, max(ts))
        if g['axis'] == 'y': return (c[0] - R, min(ts), c[1] - R), (c[0] + R, max(ts), c[1] + R)
        return (min(ts), c[0] - R, c[1] - R), (max(ts), c[0] + R, c[1] + R)
    P = [to3d(g['kind'], q, t) for q in g['pts'] for t in (g['a'], g['b'])]
    return tuple(min(v[i] for v in P) for i in range(3)), tuple(max(v[i] for v in P) for i in range(3))

# ---------------------------------------------------------------- recipe
def compile_product(prod, kn_lookup=None):
    mats = prod.get('materials', {}); kit = kit_materials()
    parts = expand(prod['parts'])
    ops, values, about_extra = [], dict(prod.get('values', {})), ''
    if prod.get('category'): ops.append({"op": "set_category", "name": prod['category']})
    if prod.get('shared'): ops.append({"op": "set_family_params", "name": "family", "shared": True})
    for prm, typ, grp in (("Voltage", "Voltage", "Electrical"), ("Number of Poles", "NumberOfPoles", "Electrical"), ("Apparent Load", "ApparentPower", "ElectricalLoads")):
        if prm in prod.get('type_values', {}): ops.append({"op": "add_family_param", "name": prm, "type": typ, "group": grp})
    cat = prod.get('category') or TEMPLATE_CAT.get(prod.get('template', 'Metric Generic Model.rft'), 'Generic Models')
    kp = kit_params(cat)
    for n, g in list(GUID.items()) + list(OPEN.items()):
        kp.setdefault(n, {"guid": g, "binding": "Instance" if n == "FMC_Geometry_Stage" else "Type"})
    # owner, 17 Oct: every shared parameter the kit binds to this category, as the kit binds it (SPR-005/006/016/021);
    # brand and model stay blank for review (supplier: kit change request FMC_Supplier)
    for n, p in kp.items(): ops.append({"op": "add_shared_param", "name": n, "guid": p['guid'], "instance": p['binding'] == 'Instance'})
    kn = prod.get('keynote') or (kn_lookup or {}).get(prod['family'], '')
    ref = prod.get('reference', {})
    for t in prod['types']:
        tn = t['name']; ops.append({"op": "add_type", "name": tn})
        tv = {"FMC_Cost_Unit": prod.get('cost_unit', 'nr'), "FMC_Geometry_Stage": "G4", "IfcExportAs": prod['ifc'], "Description": t.get('desc', prod['desc'])}
        if kn:
            tv.update({"Keynote": kn, "FMC_Keynote_Code": kn})
            txt, grp = keynote_text(kn)
            if txt and "FMC_Code_Description" in kp: tv["FMC_Code_Description"] = txt
            if grp and "FMC_Code_Group" in kp: tv["FMC_Code_Group"] = grp
        if "FMC_Role_Code" in kp: tv["FMC_Role_Code"] = prod['family'].split('_')[1]
        if "IfcExportType" in kp and prod.get('ifc_type'): tv["IfcExportType"] = prod['ifc_type']
        if ref.get('photo') or ref.get('url'): tv['URL'] = ref.get('photo') or ref['url']
        tv.update(prod.get('type_values', {})); tv.update(t.get('values', {}))
        ops += [{"op": "set_type_value", "name": f"{tn}/{k}", "type": tn, "param": k, "value": v} for k, v in tv.items()]
    used = []
    for p in parts:
        m = p.get('mat')
        if m and m not in used and not p.get('void'): used.append(m)
    title = lambda m: m.replace('_', ' ').title()
    for m in used:
        kitname = mats[m]
        col = hexrgb(kit.get(kitname, {}).get('graphics', {}).get('shaded'))
        ops.append({"op": "add_subcategory", "name": title(m), "color": col, "line_weight_projection": 1})
        if kitname in kit or not kit:
            ops += [{"op": "add_family_param", "name": f"{title(m)} Material", "type": "Material", "group": "Materials"},
                    {"op": "add_material", "name": kitname, "param": f"{title(m)} Material"}]
    ops.append({"op": "add_subcategory", "name": "Coarse Envelope", "color": [120, 130, 140], "line_weight_projection": 2})
    for c in prod.get('clearances', []): ops.append({"op": "add_subcategory", "name": c['sub'], "color": [111, 168, 220], "line_weight_projection": 1})
    # coarse envelope = bounds of all solid parts
    lo, hi = [1e9] * 3, [-1e9] * 3
    geos = []
    for p in parts:
        g = norm(p); geos.append((p, g))
        if p.get('void') or p.get('clear'): continue
        a, b = bounds(g); lo = [min(lo[i], a[i]) for i in range(3)]; hi = [max(hi[i], b[i]) for i in range(3)]
    env = [round(v, 1) for v in lo + hi]
    ops += solid_ops({"n": "Coarse Envelope"}, dict(kind='plan', pts=rrect(env[0], env[1], env[3], env[4]), a=env[2], b=env[5]), 'Coarse Envelope', None, 'c')
    for p, g in geos:
        sub = title(p['mat']) if p.get('mat') else None
        ops += solid_ops(p, g, sub, (title(p['mat']) + ' Material') if p.get('mat') and (mats[p['mat']] in kit or not kit) else None, p.get('lod', 'mf'))
    for c in prod.get('clearances', []):
        g = norm(c); ops += solid_ops(c, g, c['sub'], None, 'cmf')
    # per-type geometry (17 Oct): a part with "only": [type, ...] shows only in those types, through a Yes/No type
    # parameter "Show <types>" set per type, so one family carries the L, U and straight versions, or each size
    groups = {}
    for p in parts:
        if p.get('only'): groups.setdefault(tuple(p['only']), []).append(p['n'])
    tnames = [t['name'] for t in prod['types']]
    for only, names in groups.items():
        prm = "Show " + " or ".join(only)
        ops.append({"op": "add_family_param", "name": prm, "type": "YesNo", "group": "Graphics"})
        for tn in tnames: ops.append({"op": "set_type_value", "name": f"{tn}/{prm}", "type": tn, "param": prm, "value": tn in only})
        for n in names: ops.append({"op": "set_visible_param", "name": f"{n}/Visible", "solid": n, "param": prm})
    if cat == "Medical Equipment":
        dropped = [c['n'] for c in prod.get('connectors', []) if c['domain'] != 'electrical']
        if dropped: about_extra = " Medical Equipment can't join piping or duct systems (QE4), so " + ", ".join(dropped) + " reach it through the nested service point."
        prod = dict(prod, connectors=[c for c in prod.get('connectors', []) if c['domain'] == 'electrical'])
    for c in prod.get('connectors', []):
        o = {"op": "add_connector", "name": c['n'], "domain": c['domain'], "system": SYS_ALIAS.get(c['system'], c['system']), "solid": c['part'], "side": c.get('side', 'back')}
        for k in ('diameter', 'width', 'height', 'flow'):
            if k in c: o[k] = c[k]
        ops.append(o)
        if c['domain'] == 'electrical':
            for prm in ("Voltage", "Number of Poles", "Apparent Load"):
                if prm in prod.get('type_values', {}):
                    ops.append({"op": "link_connector_param", "name": f"{c['n']}/{prm}", "connector": c['n'], "connector_param": prm, "param": prm})
    for n in prod.get('nested', []): ops += n
    # owner, 17 Oct: the 3D picture is the Type Image (Type Properties, schedules, legends); render_type_image makes it
    role = prod['family'].split('_')[1]
    ops.append({"op": "set_type_image", "name": "Type image", "path": f"{STAGING}\\{role}\\_Images\\{prod['family']}.png"})
    about = prod.get('about', '') + about_extra
    if ref:
        about += ' Reference: ' + '; '.join(f"{k}: {v}" for k, v in ref.items() if v)
    r = {"schema": "fmc-recipe/0.1", "family": prod['family'], "template": prod.get('template', 'Metric Generic Model.rft'), "about": about.strip(), "ops": ops, "values": values}
    if prod.get('keynote_exempt'): r['checks'] = {"keynote_exempt": prod['keynote_exempt']}
    return r

def solid_ops(p, g, sub, matparam, lod):
    name, void = p['n'], p.get('void')
    if g['kind'] == 'turn':
        prof = g['profile']
        if g['axis'] == 'y': prof = [[r, -t] for r, t in prof]   # engine: axis y depth runs toward -y (room side)
        o = {"op": "revolution", "name": name, "profile": prof, "axis_at": g['c'], "axis": g['axis']}
        if sub: o['subcategory'] = sub
        ops = [o]
    else:
        o = {"op": "void_extrusion" if void else "extrusion", "name": name, "points": g['pts'], "start": round(g['a'], 2), "end": round(g['b'], 2)}
        if g['kind'] == 'front': o['sketch'] = 'front'; o['start'], o['end'] = round(-g['b'], 2), round(-g['a'], 2)
        if g['kind'] == 'right': o['sketch'] = 'right'
        ops = [o]
        if sub and not void: ops.append({"op": "set_subcategory", "name": name, "subcategory": sub})
    if void: return ops
    if matparam: ops.append({"op": "set_material_param", "name": name, "param": matparam})
    ops.append({"op": "set_visibility", "name": name, "coarse": 'c' in lod, "medium": 'm' in lod, "fine": 'f' in lod})
    return ops

def mesh(g, seg=32):
    """Triangles (3 points each) for a part."""
    tris = []
    if g['kind'] == 'turn':
        prof = g['profile']; c = g['c']; ax = g['axis']
        def P(r, t, a):
            u, v = r * math.cos(a), r * math.sin(a)
            if ax == 'z': return (c[0] + u, c[1] + v, t)
            if ax == 'y': return (c[0] + u, t, c[1] + v)
            return (t, c[0] + u, c[1] + v)
        for i in range(seg):
            a0, a1 = 2 * math.pi * i / seg, 2 * math.pi * (i + 1) / seg
            for j in range(len(prof)):
                (r0, t0), (r1, t1) = prof[j], prof[(j + 1) % len(prof)]
                p00, p01, p10, p11 = P(r0, t0, a0), P(r1, t1, a0), P(r0, t0, a1), P(r1, t1, a1)
                tris += [(p00, p01, p11), (p00, p11, p10)]
        return tris
    pts, a, b, k = g['pts'], g['a'], g['b'], g['kind']
    cx = sum(q[0] for q in pts) / len(pts); cy = sum(q[1] for q in pts) / len(pts)
    for t in (a, b):
        for i in range(len(pts)):
            tris.append((to3d(k, (cx, cy), t), to3d(k, pts[i], t), to3d(k, pts[(i + 1) % len(pts)], t)))
    for i in range(len(pts)):
        q0, q1 = pts[i], pts[(i + 1) % len(pts)]
        tris += [(to3d(k, q0, a), to3d(k, q1, a), to3d(k, q1, b)), (to3d(k, q0, a), to3d(k, q1, b), to3d(k, q0, b))]
    return tris

# ---------------------------------------------------------------- preview (z-buffer renderer, numpy + PIL)
import re as _re
GLASS_TAG = 100000
GLASS_RE = _re.compile(r'^(?!.*Display)(?=.*(Glass|Glazing|Polycarbonate_Clear|Acrylic_Clear|Perspex))', _re.I)

def _tris(prod, lod):
    import numpy as np
    kit = kit_materials(); mats = prod.get('materials', {})
    T, C, I = [], [], []
    first = prod['types'][0]['name'] if prod.get('types') else None
    show_t = prod.get('_render_type') or first
    parts = [p for p in expand(prod['parts']) if not p.get('void') and lod in p.get('lod', 'mf') and (not p.get('only') or show_t in p['only'])]
    for i, p in enumerate(parts):
        mname = mats.get(p.get('mat'), '')
        rgb = np.array(hexrgb(kit.get(mname, {}).get('graphics', {}).get('shaded'))) / 255.0
        tag = i + GLASS_TAG if GLASS_RE.search(mname or '') else i   # see-through parts are drawn after the solids, blended
        for t in mesh(norm(p), p.get('seg', 32)): T.append(t); C.append(rgb); I.append(tag)
    return np.array(T, float), np.array(C, float), np.array(I), len(parts)

def _view(T, C, I, az, el, W, H, persp=False):
    import numpy as np
    a, e = math.radians(az), math.radians(el)
    f = np.array([math.cos(e) * math.sin(a), math.cos(e) * math.cos(a), -math.sin(e)])   # camera looks along f
    up0 = np.array([0, 0, 1.0]) if abs(f[2]) < 0.99 else np.array([0, 1.0, 0])
    r = np.cross(f, up0); r /= np.linalg.norm(r); u = np.cross(r, f)
    P = T.reshape(-1, 3); X, Y, Z = P @ r, P @ u, P @ f
    lo, hi = np.array([X.min(), Y.min()]), np.array([X.max(), Y.max()]); span = max(hi - lo) * 1.12; c = (lo + hi) / 2
    s = min(W, H) / span
    sx = (X - c[0]) * s + W / 2; sy = H / 2 - (Y - c[1]) * s
    sx, sy, Z = sx.reshape(-1, 3), sy.reshape(-1, 3), Z.reshape(-1, 3)
    n = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]); ln = np.linalg.norm(n, axis=1, keepdims=True); ln[ln == 0] = 1; n /= ln
    L1 = -f * 0.55 + u * 0.6 + r * 0.25; L1 /= np.linalg.norm(L1); L2 = np.array([0.3, -0.5, 0.8]); L2 /= np.linalg.norm(L2)
    lam = 0.58 + 0.30 * np.abs(n @ L1) + 0.12 * np.abs(n @ L2)
    spec = np.clip(np.abs(n @ (L1 - f) / np.linalg.norm(L1 - f)), 0, 1) ** 24 * 0.25
    col = np.clip(C * lam[:, None] + spec[:, None], 0, 1)
    zb = np.full((H, W), np.inf); img = np.ones((H, W, 3)); idb = np.full((H, W), -1)
    glass = I >= GLASS_TAG
    def raster(k):
        x0, x1 = int(max(0, np.floor(sx[k].min()))), int(min(W - 1, np.ceil(sx[k].max())))
        y0, y1 = int(max(0, np.floor(sy[k].min()))), int(min(H - 1, np.ceil(sy[k].max())))
        if x1 < x0 or y1 < y0: return None
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        (ax_, bx, cx), (ay, by, cy) = sx[k], sy[k]
        d = (by - cy) * (ax_ - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-9: return None
        w0 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / d; w1 = ((cy - ay) * (xs - cx) + (ax_ - cx) * (ys - cy)) / d; w2 = 1 - w0 - w1
        m = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not m.any(): return None
        return x0, x1, y0, y1, m, w0 * Z[k, 0] + w1 * Z[k, 1] + w2 * Z[k, 2]
    for k in range(len(T)):
        if glass[k]: continue
        x0, x1 = int(max(0, np.floor(sx[k].min()))), int(min(W - 1, np.ceil(sx[k].max())))
        y0, y1 = int(max(0, np.floor(sy[k].min()))), int(min(H - 1, np.ceil(sy[k].max())))
        if x1 < x0 or y1 < y0: continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        (ax_, bx, cx), (ay, by, cy) = sx[k], sy[k]
        d = (by - cy) * (ax_ - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-9: continue
        w0 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / d; w1 = ((cy - ay) * (xs - cx) + (ax_ - cx) * (ys - cy)) / d; w2 = 1 - w0 - w1
        m = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not m.any(): continue
        z = w0 * Z[k, 0] + w1 * Z[k, 1] + w2 * Z[k, 2]
        sub = zb[y0:y1 + 1, x0:x1 + 1]; upd = m & (z < sub - 1e-6)
        sub[upd] = z[upd]; img[y0:y1 + 1, x0:x1 + 1][upd] = col[k]; idb[y0:y1 + 1, x0:x1 + 1][upd] = I[k]
    # outlines: part boundaries and depth jumps
    edge = np.zeros((H, W), bool)
    for dy, dx in ((0, 1), (1, 0)):
        a1, b1 = idb[:H - dy, :W - dx], idb[dy:, dx:]
        za, zb2 = zb[:H - dy, :W - dx], zb[dy:, dx:]
        jump = (a1 != b1) | (np.abs(np.nan_to_num(za, posinf=1e9) - np.nan_to_num(zb2, posinf=1e9)) > span * 0.01)
        edge[:H - dy, :W - dx] |= jump
    img[edge] = img[edge] * 0.35 + 0.08
    # glass: a light tint over what is behind it, never hiding it (Revit draws glazing transparent too)
    gl = np.zeros((H, W), bool)
    for k in np.nonzero(glass)[0]:
        r_ = raster(k)
        if r_ is None: continue
        x0, x1, y0, y1, m, z = r_
        upd = m & (z < zb[y0:y1 + 1, x0:x1 + 1] - 1e-6) & ~gl[y0:y1 + 1, x0:x1 + 1]
        blk = img[y0:y1 + 1, x0:x1 + 1]; blk[upd] = blk[upd] * 0.72 + np.array([0.62, 0.78, 0.86]) * 0.28
        gl[y0:y1 + 1, x0:x1 + 1] |= upd
    return img

CEILING_CATS = {"Fire Alarm Devices", "Lighting Fixtures", "Sprinklers", "Air Terminals", "Communication Devices", "Security Devices",
                "Data Devices", "Nurse Call Devices", "Lighting Devices"}
def hangs(T, prod=None):
    """A ceiling product is seen from below: prod 'view': 'below' says so, or a ceiling category with everything at or
    below z = 0. Products sunk into the ground (top at z = 0) are not ceiling products and keep the view from above."""
    if prod is not None and prod.get('view') in ('below', 'above'): return prod['view'] == 'below'
    if prod is not None and prod.get('category') not in CEILING_CATS: return False
    return bool(len(T)) and T[:, :, 2].max() <= 30 and T[:, :, 2].min() < -10

def render(prod, path, lod='f', views=(('3D', -35, 22), ('Front', 0, 0), ('Side', 90, 0), ('Plan', 0, 89.9)), W=520, H=420):
    import numpy as np
    from PIL import Image, ImageDraw
    T, C, I, n = _tris(prod, lod)
    if hangs(T, prod): views = tuple((t, a, -25 if t == '3D' else e) for t, a, e in views)
    tiles = []
    for title, az, el in views:
        im = Image.fromarray((_view(T, C, I, az, el, W, H) * 255).astype('uint8'))
        ImageDraw.Draw(im).text((10, 8), title, fill=(60, 66, 76)); tiles.append(im)
    sheet = Image.new('RGB', (W * len(tiles), H + 34), 'white')
    for i, t in enumerate(tiles): sheet.paste(t, (i * W, 34))
    ref = prod.get('reference', {})
    ImageDraw.Draw(sheet).text((10, 10), f"{prod['family']}  -  {n} parts at {lod.upper()}  -  ref: {ref.get('query', ref.get('basis', ''))}", fill=(20, 24, 30))
    sheet.save(path); return path

def render_type_image(prod, path, lod='f', size=800):
    """The Type Image: one 3D view, rendered at twice the size and scaled down for clean edges, on white."""
    from PIL import Image
    T, C, I, n = _tris(prod, lod)
    im = Image.fromarray((_view(T, C, I, -35, -25 if hangs(T, prod) else 22, size * 2, size * 2) * 255).astype('uint8'))
    im.resize((size, size), Image.LANCZOS).save(path); return path

if __name__ == '__main__':
    prod = json.load(open(sys.argv[1]))
    r = compile_product(prod)
    out = sys.argv[2] if len(sys.argv) > 2 else prod['family'] + '.recipe.json'
    json.dump(r, open(out, 'w'), indent=1)
    render(prod, out.replace('.recipe.json', '.preview.png'))
    print(out, len(r['ops']), 'ops')
