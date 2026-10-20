"""Recipe (fmc-recipe/0.1) -> geometry IR in mm, Revit family coordinates (x right, y back, z up)."""
import json, math

def load(path):
    d = json.load(open(path))
    ops = d['ops']
    planes = {'Center (Front/Back)': ('y', 0.0), 'Center (Left/Right)': ('x', 0.0), 'Ref. Level': ('z', 0.0)}
    for o in ops:
        if o['op'] != 'add_ref_plane': continue
        (x1, y1), (x2, y2) = o['from'], o['to']
        if o.get('view') == 'Front':
            planes[o['name']] = ('z', y1)
        elif o.get('view') in ('Right', 'Left'):
            planes[o['name']] = ('z', y1)
        elif abs(x1 - x2) < 1e-6:
            planes[o['name']] = ('x', x1)
        else:
            planes[o['name']] = ('y', y1)
    mat_param = {}      # param -> material name
    for o in ops:
        if o['op'] == 'add_material': mat_param[o['param']] = o['name']
    solid_mat, solid_sub, solid_vis = {}, {}, {}
    for o in ops:
        if o['op'] == 'set_material_param': solid_mat[o['name']] = mat_param.get(o['param'])
        if o['op'] == 'set_subcategory': solid_sub[o['name']] = o['subcategory']
        if o['op'] == 'set_visibility': solid_vis[o['name']] = (o.get('coarse'), o.get('medium'), o.get('fine'))
    solids = []
    for o in ops:
        k = o['op']
        if k not in ('extrusion', 'void_extrusion', 'revolution', 'sweep'): continue
        s = dict(o)
        s['void'] = k.startswith('void')
        s['material'] = solid_mat.get(o['name'])
        s['sub'] = solid_sub.get(o['name'], '')
        s['vis'] = solid_vis.get(o['name'], (True, True, True))
        if 'rect' in o:
            a, b, c, dd = [planes[n][1] for n in o['rect']]
            s['kind'] = 'box'
            z0 = o['start']; z1 = planes[o['end_plane']][1] if o.get('end_plane') else o['end']
            s['box'] = (min(a, b), min(c, dd), min(z0, z1), max(a, b), max(c, dd), max(z0, z1))
        elif k.endswith('extrusion'):
            s['kind'] = 'extrude'
        elif k == 'revolution':
            s['kind'] = 'revolve'
        else:
            s['kind'] = 'tube'
        solids.append(s)
    return d, planes, solids

# --- orientation conventions (verified against Rhino twin bounding boxes) ---
def to_world_extrude(sketch, u, v, w):
    if sketch == 'plan':  return (u, v, w)
    if sketch == 'front': return (u, -w, v)       # (x,z) sketch, depth along -y
    if sketch == 'right': return (w, u, v)        # (y,z) sketch, depth along x
    raise ValueError(sketch)

def to_world_revolve(axis, at, r, t, ang):
    c, s = r * math.cos(ang), r * math.sin(ang)
    if axis in ('z', None): return (at[0] + c, at[1] + s, t)
    if axis == 'x': return (t, at[0] + c, at[1] + s)
    if axis == 'y': return (at[0] + c, -t, at[1] + s)

def to_world_path(plane, at, u, v):
    if plane == 'front': return (u, at, v)
    if plane == 'right': return (at, u, v)
    if plane == 'plan':  return (u, v, at)

def sample_points(s):
    """Points on the solid (for bbox checks)."""
    k = s['kind']
    if k == 'box':
        x0, y0, z0, x1, y1, z1 = s['box']
        return [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    if k == 'extrude':
        out = []
        for (u, v) in s['points']:
            for w in (s['start'], s['end']):
                out.append(to_world_extrude(s['sketch'], u, v, w))
        return out
    if k == 'revolve':
        out = []
        a0, a1 = math.radians(s.get('start_deg', 0)), math.radians(s.get('end_deg', 360))
        for (r, t) in s['profile']:
            for i in range(25):
                out.append(to_world_revolve(s.get('axis'), s['axis_at'], r, t, a0 + (a1 - a0) * i / 24))
        return out
    if k == 'tube':
        rad = max(math.hypot(*p) for p in s['profile'])
        out = []
        for (u, v) in s['path']:
            x, y, z = to_world_path(s['path_plane'], s['at'], u, v)
            for dx in (-rad, rad):
                for dy in (-rad, rad):
                    for dz in (-rad, rad):
                        out.append((x + dx, y + dy, z + dz))
        return out

def bbox(s):
    p = sample_points(s)
    return [min(q[i] for q in p) for i in range(3)], [max(q[i] for q in p) for i in range(3)]
