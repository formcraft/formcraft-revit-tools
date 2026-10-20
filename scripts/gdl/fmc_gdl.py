"""Formcraft recipe (fmc-recipe/0.1) -> ArchiCAD GDL library part (XML for LP_XMLConverter xml2libpart).

One recipe gives one object with three levels of detail:
  1 Coarse (LOD 200)  the envelope box
  2 Medium (LOD 300)  the native body, faceted (low resolution, hard edges)
  3 Fine   (LOD 400)  the same parts, smooth (high resolution, soft edges, contour-only lines)
Plan symbol by drawing scale (1:50 detailed projection, 1:100 simplified projection, 1:200 outline),
clearance zone with scale-aware dashes, kit surfaces defined inline, FMC data as parameters,
and a four-page Formcraft settings dialog.
Coordinates: recipe mm -> GDL metres; the object box starts at its origin (0..A, 0..B, 0..ZZYZX).
"""
import json, math, uuid, sys, os, html
sys.path.insert(0, os.path.dirname(__file__))
import ir

NS = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
F = lambda v: ('%.5f' % v).rstrip('0').rstrip('.') if abs(v) >= 1e-9 else '0'
M = lambda v: F(v / 1000.0)

# ---------------------------------------------------------------- materials
def hex_rgb(h):
    h = h.lstrip('#'); return [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]

def material_def(m):
    """DEFINE MATERIAL type 0 (16 values) from a kit material."""
    name, cls = m['name'], m.get('class', '')
    r, g, b = hex_rgb(m.get('graphics', {}).get('shaded') or '#B4B4B4')
    amb, dif, spe, tra, shi, att = 0.7, 0.75, 0.35, 0.0, 20.0, 1.0
    em = (0, 0, 0)
    n = name.lower()
    if cls == 'Glass' or 'glass' in n:
        amb, dif, spe, tra, shi, att = 0.6, 0.35, 0.9, 0.72, 60.0, 1.6
        if 'frosted' in n: tra, spe = 0.45, 0.4
        if 'display' in n or 'black' in n: tra, spe, shi = 0.05, 0.85, 80.0
    elif cls == 'Metal' or 'metal' in n or 'chrome' in n or 'stainless' in n:
        amb, dif, spe, shi = 0.6, 0.55, 0.9, 70.0 if 'chrome' in n else 45.0
        if 'painted' in n or 'epoxy' in n: dif, spe, shi = 0.8, 0.45, 25.0
    elif 'rubber' in n:
        amb, dif, spe, shi = 0.7, 0.85, 0.1, 5.0
    elif 'fabric' in n or 'upholstery' in n or 'vinyl' in n:
        amb, dif, spe, shi = 0.75, 0.85, 0.25, 12.0
    elif 'led' in n:
        amb, dif, spe, shi = 0.9, 0.6, 0.6, 50.0; em = (r, g, b)
    spec = (1.0, 1.0, 1.0) if spe > 0.5 else (r, g, b)
    vals = [r, g, b, amb, dif, spe, tra, shi, att, *spec, *em, 0.0 if em == (0, 0, 0) else 2.0]
    return 'DEFINE MATERIAL "%s" 0, %s' % (name, ', '.join(F(v) for v in vals))

# ---------------------------------------------------------------- geometry helpers
def turn_deg(a, b, c):
    v1 = (b[0] - a[0], b[1] - a[1]); v2 = (c[0] - b[0], c[1] - b[1])
    n1, n2 = math.hypot(*v1), math.hypot(*v2)
    if n1 < 1e-9 or n2 < 1e-9: return 0.0
    cosv = max(-1, min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
    return math.degrees(math.acos(cosv))

def dedupe(pts, tol=1e-6):
    out = []
    for p in pts:
        if not out or max(abs(p[i] - out[-1][i]) for i in range(len(p))) > tol: out.append(p)
    return out

def smooth_flags(pts, closed, limit=28.0):
    """True where the polyline bends gently (a smooth curve node)."""
    n = len(pts); fl = []
    for i in range(n):
        if not closed and (i == 0 or i == n - 1): fl.append(False); continue
        a, b, c = pts[i - 1], pts[i], pts[(i + 1) % n]
        fl.append(turn_deg(a, b, c) < limit)
    return fl

# ---------------------------------------------------------------- per-solid GDL
def gdl_solid(s, flip):
    """3D script lines for one solid; uses variables res and soft (0/1)."""
    L = []
    k = s['kind']
    if k == 'box':
        x0, y0, z0, x1, y1, z1 = s['box']
        L += ['ADD %s, %s, %s' % (M(x0), M(y0), M(z0)), 'BLOCK %s, %s, %s' % (M(x1 - x0), M(y1 - y0), M(z1 - z0)), 'DEL 1']
    elif k == 'extrude':
        pts = dedupe([tuple(p) for p in s['points']])
        if pts[0] == pts[-1]: pts = pts[:-1]
        sm = smooth_flags(pts, True)
        lo, hi = min(s['start'], s['end']), max(s['start'], s['end'])
        sk = s['sketch']
        nt = 0
        if sk == 'front': L.append('ROTX 90'); nt += 1
        elif sk == 'right': L += ['ROTZ 90', 'ROTX 90']; nt += 2
        L.append('ADDZ %s' % M(lo)); nt += 1
        rows = ['%s, %s, %s' % (M(u), M(v), ('soft' if f else '0')) for (u, v), f in zip(pts, sm)]
        rows.append('%s, %s, %s' % (M(pts[0][0]), M(pts[0][1]), 'soft' if sm[0] else '0'))
        L.append('EXTRUDE %d, 0, 0, %s, 1+2+16+32,' % (len(rows), M(hi - lo)))
        L.append('\t' + ',\n\t'.join(rows))
        L.append('DEL %d' % nt)
    elif k == 'revolve':
        prof = dedupe([tuple(p) for p in s['profile']])
        ax, at = s.get('axis'), s['axis_at']
        on0, on1 = prof[0][0] == 0, prof[-1][0] == 0
        closed = not (on0 or on1)
        if closed and prof[0] == prof[-1]: prof = prof[:-1]
        sm = smooth_flags(prof, closed)
        nodes = [(t, r, f) for (r, t), f in zip(prof, sm)]
        if closed: nodes.append(nodes[0])
        mask = 0 if closed else (1 + 2 + 16 + 32)
        nt = 0
        if ax in ('z', None): L += ['ADD %s, %s, 0' % (M(at[0]), M(at[1])), 'ROTY -90']; nt = 2
        elif ax == 'x': L += ['ADD 0, %s, %s' % (M(at[0]), M(at[1]))]; nt = 1
        elif ax == 'y': L += ['ADD %s, 0, %s' % (M(at[0]), M(at[1])), 'ROTZ -90']; nt = 2
        rows = ['%s, %s, %s' % (M(t), M(r), ('soft' if f else '0')) for t, r, f in nodes]
        L.append('REVOLVE %d, 360, %d,' % (len(rows), mask))
        L.append('\t' + ',\n\t'.join(rows))
        L.append('DEL %d' % nt)
    elif k == 'tube':
        prof = dedupe([tuple(p) for p in s['profile']])
        if prof[0] == prof[-1]: prof = prof[:-1]
        sm = smooth_flags(prof, True, 50.0)
        path = dedupe([ir.to_world_path(s['path_plane'], s['at'], u, v) for (u, v) in s['path']])
        if len(path) < 2: return []
        p0 = tuple(2 * path[0][i] - path[1][i] for i in range(3))
        pn = tuple(2 * path[-1][i] - path[-2][i] for i in range(3))
        full = [p0] + path + [pn]
        prow = ['%s, %s, %s' % (M(u), M(v), ('soft' if f else '0')) for (u, v), f in zip(prof, sm)]
        trow = ['%s, %s, %s, 0' % (M(x), M(y), M(z)) for (x, y, z) in full]
        L.append('TUBE %d, %d, 1+2+16+32,' % (len(prow), len(trow)))
        L.append('\t' + ',\n\t'.join(prow) + ',')
        L.append('\t' + ',\n\t'.join(trow))
    return L

# ---------------------------------------------------------------- object build
def build(recipe_path, materials_path, out_dir, params_extra=None):
    d, planes, solids = ir.load(recipe_path)
    fam = d['family']
    ops = d['ops']
    kit = {m['name']: m for m in json.load(open(materials_path))['materials']}
    tv = {}
    for o in ops:
        if o['op'] == 'set_type_value' and o['param'] not in tv: tv[o['param']] = o['value']
    vis_param = {o['solid']: o['param'] for o in ops if o['op'] == 'set_visible_param'}
    ceiling = 'Ceiling' in str(tv.get('Host Type', '')) or 'face based' in d.get('template', '')

    body = [s for s in solids if s['vis'][1] and not s['sub'].startswith('Clearance') and s['sub'] != 'Coarse Envelope'
            and not s['void'] and s['sub'] != 'Light Path']
    voids = [s for s in solids if s['void']]
    coarse = [s for s in solids if s['sub'] == 'Coarse Envelope']
    clear = [s for s in solids if s['sub'].startswith('Clearance')]
    beam = [s for s in solids if s['sub'] == 'Light Path']

    # world box of the body + envelope
    def wbox(ss):
        lo = [1e18] * 3; hi = [-1e18] * 3
        for s in ss:
            a, b = ir.bbox(s)
            if ceiling: a, b = [a[0], -b[1], -b[2]], [b[0], -a[1], -a[2]]
            lo = [min(lo[i], a[i]) for i in range(3)]; hi = [max(hi[i], b[i]) for i in range(3)]
        return lo, hi
    blo, bhi = wbox(body + coarse)
    A, B, H = bhi[0] - blo[0], bhi[1] - blo[1], bhi[2] - blo[2]

    # size class: 2 = large part (kept in the simplified plan), 1 = small detail
    def rank(s):
        a, b = ir.bbox(s)
        ext = sorted([b[i] - a[i] for i in range(3)], reverse=True)
        return 2 if (ext[0] * ext[1]) >= 0.012 * A * B else 1

    mats = sorted({s['material'] for s in body + beam if s['material']})
    short = {}
    for m in mats:
        tag = m.replace('FMC_', '').split('_')
        short[m] = 'srf' + ''.join(t[:1].upper() + t[1:] for t in tag[-2:])[:24]

    # ---------------- 3D script
    S = []
    S += ['! Formcraft %s · generated from the Formcraft recipe (fmc_gdl.py)' % fam,
          '! Kit surfaces defined inline, so the object looks the same in any template.']
    for m in mats: S.append(material_def(kit[m]))
    S += ['', 'iLOD = iLOD3D', 'IF GLOB_CONTEXT = 5 THEN iLOD = 3',
          'IF iLOD = 3 THEN', '\tres = iRes : soft = 1', 'ELSE', '\tres = 10 : soft = 0', 'ENDIF',
          'RESOL res', 'PEN penModel', '']
    S.append('ADD %s, %s, %s' % (M(-blo[0]), M(-blo[1]), M(-blo[2])))
    if ceiling:
        S += ['! ceiling mounted: the top of the box is the ceiling face; the light hangs below it', 'ROTX 180']
    S += ['', 'HOTSPOT 0, 0, 0'] if False else ['']
    # coarse
    S += ['IF iLOD = 1 THEN', '\tSET MATERIAL %s' % ('srfCoarse' if True else ''),]
    for s in coarse: S += ['\t' + l for l in gdl_solid(s, ceiling)]
    S += ['ELSE']
    # body parts, voids as booleans
    cut_pairs = {}
    for v in voids:
        va, vb = ir.bbox(v)
        for s in body:
            sa, sb = ir.bbox(s)
            if all(sa[i] < vb[i] and va[i] < sb[i] for i in range(3)):
                cut_pairs.setdefault(s['name'], []).append(v)
    for s in body:
        cond = []
        if rank(s) == 1: cond.append('bSmall')
        if s['name'] in vis_param: cond.append(vis_param[s['name']].replace(' ', '_').replace('-', '_'))
        ind = '\t'
        if cond: S.append('\tIF %s THEN' % ' AND '.join(cond)); ind = '\t\t'
        m = s['material']
        S.append(ind + '! %s' % s['name'])
        S.append(ind + 'IF bKitSurfaces THEN SET MATERIAL "%s" ELSE SET MATERIAL %s' % (m, short[m]))
        if s['name'] in cut_pairs:
            g = 'g_' + s['name'].replace(' ', '_')
            S.append(ind + 'GROUP "%s"' % g)
            S += [ind + '\t' + l for l in gdl_solid(s, ceiling)]
            S.append(ind + 'ENDGROUP')
            for j, v in enumerate(cut_pairs[s['name']]):
                S.append(ind + 'GROUP "%s_v%d"' % (g, j))
                S += [ind + '\t' + l for l in gdl_solid(v, ceiling)]
                S.append(ind + 'ENDGROUP')
            expr = '"%s"' % g
            for j in range(len(cut_pairs[s['name']])):
                expr = 'SUBGROUP(%s, "%s_v%d")' % (expr, g, j)
            S.append(ind + 'PLACEGROUP ' + expr)
        else:
            S += [ind + l for l in gdl_solid(s, ceiling)]
        if cond: S.append('\tENDIF')
    S += ['ENDIF', '']
    if beam:
        S += ['IF bLightBeam THEN', '\tSET MATERIAL "FMC_Glass_Clear"']
        for s in beam: S += ['\t' + l for l in gdl_solid(s, ceiling)]
        S += ['ENDIF', '']
    if clear:
        S += ['IF bShowClearance AND bClear3D THEN', '\tSET MATERIAL srfClearance']
        for s in clear: S += ['\t' + l for l in gdl_solid(s, ceiling)]
        S += ['ENDIF', '']
    S += ['DEL TOP', '! box hotspots',
          'HOTSPOT 0, 0, 0 : HOTSPOT A, 0, 0 : HOTSPOT A, B, 0 : HOTSPOT 0, B, 0',
          'HOTSPOT 0, 0, ZZYZX : HOTSPOT A, 0, ZZYZX : HOTSPOT A, B, ZZYZX : HOTSPOT 0, B, ZZYZX']
    script3d = '\n'.join(S)

    # ---------------- 2D script
    def plan_rect(ss):
        lo = [1e18] * 2; hi = [-1e18] * 2
        for s in ss:
            a, b = ir.bbox(s)
            if ceiling: a, b = [a[0], -b[1]], [b[0], -a[1]]
            lo = [min(lo[i], a[i]) for i in range(2)]; hi = [max(hi[i], b[i]) for i in range(2)]
        ox, oy = -blo[0], (-blo[1])
        return (lo[0] + ox, lo[1] + oy, hi[0] + ox, hi[1] + oy)
    cr = plan_rect(clear) if clear else None
    br = plan_rect(body)
    extra_pp = (', bClear3D = 0' if clear else '') + (', bLightBeam = 0' if beam else '')
    T = []
    T += ['! Formcraft plan symbol: detail follows the drawing scale unless set by hand',
          'd = iLOD2D', 'IF bAutoLOD2D THEN', '\tIF GLOB_SCALE <= 50 THEN', '\t\td = 3', '\tELSE',
          '\t\tIF GLOB_SCALE <= 100 THEN d = 2 ELSE d = 1', '\tENDIF', 'ENDIF', '',
          '! cover fill under the object, so floor patterns do not show through',
          'IF bCoverFill THEN',
          '\tSET FILL fillCover', '\tPEN penContour',
          '\tPOLY2_B 4, 2+4, penFillFg, penFillBg,',
          '\t\t%s, %s, 1,  %s, %s, 1,  %s, %s, 1,  %s, %s, 1' % (
              M(br[0]), M(br[1]), M(br[2]), M(br[1]), M(br[2]), M(br[3]), M(br[0]), M(br[3])),
          'ENDIF', '',
          'PEN penContour',
          'IF d = 3 THEN', '\tPROJECT2{3} 3, 270, 2, 2+8 PARAMETERS iLOD3D = 3, bSmall = 1' + extra_pp,
          'ENDIF',
          'IF d = 2 THEN', '\tPROJECT2{3} 3, 270, 2, 2+8 PARAMETERS iLOD3D = 2, bSmall = 0' + extra_pp,
          'ENDIF',
          'IF d = 1 THEN',
          '\tRECT2 %s, %s, %s, %s' % (M(br[0]), M(br[1]), M(br[2]), M(br[3])),
          '\tLINE2 %s, %s, %s, %s' % (M(br[0]), M(br[1]), M(br[2]), M(br[3])),
          '\tLINE2 %s, %s, %s, %s' % (M(br[0]), M(br[3]), M(br[2]), M(br[1])),
          'ENDIF', '']
    if cr:
        T += ['! clearance zone: dashes sized on paper (3 mm dash, 1.5 mm gap) at any scale',
              'IF bShowClearance THEN', '\tPEN penClear', '\tdash = 0.003 * GLOB_SCALE : gap = 0.0015 * GLOB_SCALE',
              '\tDIM cx[5], cy[5]',
              '\tcx[1] = %s : cy[1] = %s' % (M(cr[0]), M(cr[1])), '\tcx[2] = %s : cy[2] = %s' % (M(cr[2]), M(cr[1])),
              '\tcx[3] = %s : cy[3] = %s' % (M(cr[2]), M(cr[3])), '\tcx[4] = %s : cy[4] = %s' % (M(cr[0]), M(cr[3])),
              '\tcx[5] = cx[1] : cy[5] = cy[1]',
              '\tFOR k = 1 TO 4', '\t\tlx = cx[k+1] - cx[k] : ly = cy[k+1] - cy[k]', '\t\tln = SQR(lx^2 + ly^2)',
              '\t\tt = 0', '\t\tWHILE t < ln DO', '\t\t\tt2 = MIN(t + dash, ln)',
              '\t\t\tLINE2 cx[k] + lx*t/ln, cy[k] + ly*t/ln, cx[k] + lx*t2/ln, cy[k] + ly*t2/ln',
              '\t\t\tt = t2 + gap', '\t\tENDWHILE', '\tNEXT k',
              '\tIF GLOB_SCALE <= 100 THEN',
              '\t\tDEFINE STYLE "fmc_note" "Arial", 1.8, 1, 0',
              '\t\tSET STYLE "fmc_note"',
              '\t\tTEXT2 %s, %s, clearLabel' % (M(cr[0] + 0.0), M(cr[1] - 0.0)),
              '\tENDIF', 'ENDIF', '']
    T += ['! name tag at detailed scales', 'IF bShowName AND GLOB_SCALE <= 50 THEN',
          '\tDEFINE STYLE "fmc_tag" "Arial", 2.0, 5, 0', '\tSET STYLE "fmc_tag"', '\tPEN penContour',
          '\tTEXT2 A/2, B/2, FMC_Keynote_Code', 'ENDIF', '',
          'HOTSPOT2 0, 0 : HOTSPOT2 A, 0 : HOTSPOT2 A, B : HOTSPOT2 0, B : HOTSPOT2 A/2, B/2']
    script2d = '\n'.join(T)

    # ---------------- parameters
    P = []  # (xmltype, name, description, value, flags)
    P.append(('Length', 'A', 'Width', A / 1000.0, ['fix']))
    P.append(('Length', 'B', 'Depth', B / 1000.0, ['fix']))
    P.append(('Length', 'ZZYZX', 'Height', H / 1000.0, ['fix']))
    P.append(('Title', 'tModel', 'Model and detail', None, ['bold']))
    P.append(('Integer', 'iLOD3D', 'Model detail', 3, ['child']))
    P.append(('Integer', 'iRes', 'Smoothness (Fine)', 36, ['child']))
    P.append(('Boolean', 'bSmall', 'Show small parts', 1, ['child']))
    P.append(('Material', 'srfCoarse', 'Coarse box surface', 1, ['child']))
    P.append(('PenColor', 'penModel', '3D contour pen', 1, ['child']))
    if any(s['name'] in vis_param for s in body):
        for pnm in sorted(set(vis_param[s['name']] for s in body if s['name'] in vis_param)):
            P.append(('Boolean', pnm.replace(' ', '_').replace('-', '_'), pnm, 1, ['child']))
    if beam: P.append(('Boolean', 'bLightBeam', 'Show light beam', 0, ['child']))
    P.append(('Title', 'tPlan', 'Plan graphics', None, ['bold']))
    P.append(('Boolean', 'bAutoLOD2D', 'Plan detail follows scale', 1, ['child']))
    P.append(('Integer', 'iLOD2D', 'Plan detail (by hand)', 2, ['child']))
    P.append(('PenColor', 'penContour', 'Contour pen', 1, ['child']))
    P.append(('Boolean', 'bCoverFill', 'Cover fill', 1, ['child']))
    P.append(('FillPattern', 'fillCover', 'Cover fill type', 65, ['child']))
    P.append(('PenColor', 'penFillFg', 'Cover fill pen', 19, ['child']))
    P.append(('PenColor', 'penFillBg', 'Cover fill background pen', 19, ['child']))
    P.append(('Boolean', 'bShowName', 'Keynote tag at 1:50', 0, ['child']))
    if clear:
        cf = tv.get('Clearance Front', '')
        P.append(('Title', 'tClear', 'Clearance zone', None, ['bold']))
        P.append(('Boolean', 'bShowClearance', 'Show clearance zone', 1, ['child']))
        P.append(('Boolean', 'bClear3D', 'Clearance zone in 3D', 0, ['child']))
        P.append(('PenColor', 'penClear', 'Clearance pen', 3, ['child']))
        P.append(('Material', 'srfClearance', 'Clearance surface (3D)', 1, ['child']))
        P.append(('String', 'clearLabel', 'Clearance label', ('CLEARANCE %s · %s' % (cf, tv.get('Clearance Basis', ''))).strip(' ·'), ['child']))
    P.append(('Title', 'tSrf', 'Surfaces', None, ['bold']))
    P.append(('Boolean', 'bKitSurfaces', 'Use Formcraft kit surfaces', 1, ['child']))
    for m in mats: P.append(('Material', short[m], m.replace('FMC_', '').replace('_', ' '), 1, ['child']))
    P.append(('Title', 'tData', 'Formcraft data', None, ['bold']))
    data_keys = ['FMC_Keynote_Code', 'FMC_Code_Description', 'IfcExportAs', 'FMC_Role_Code', 'FMC_Cost_Unit',
                 'FMC_Geometry_Stage', 'Risk Grade', 'Supply Source', 'Clearance Basis', 'Host Type', 'Legend Sheet']
    for k in data_keys:
        if k in tv: P.append(('String', k.replace(' ', '_'), k.replace('_', ' ').replace('FMC ', ''), str(tv[k]), ['child']))
    for k in ('Voltage', 'Apparent Load', 'Clearance Front'):
        if k in tv: P.append(('RealNum', 'FMC_' + k.replace(' ', '_'), k, float(tv[k]), ['child']))
    P.append(('String', 'FMC_Family', 'Formcraft family', fam, ['child']))
    P.append(('String', 'FMC_LOD_Note', 'Detail levels', 'Coarse LOD 200 · Medium LOD 300 · Fine LOD 400', ['child']))

    # ---------------- parameter script
    vp = [n for (_, n, *_r) in P]
    PR = ['VALUES{2} "iLOD3D" 1, "Coarse · LOD 200 box", 2, "Medium · LOD 300", 3, "Fine · LOD 400 smooth"',
          'VALUES{2} "iLOD2D" 1, "Outline", 2, "Simplified", 3, "Detailed"',
          'VALUES "iRes" RANGE [12, 72]',
          'PARAMETERS A = %s, B = %s, ZZYZX = %s' % (F(A / 1000), F(B / 1000), F(H / 1000)),
          'LOCK "A", "B", "ZZYZX"',
          'IF bAutoLOD2D THEN LOCK "iLOD2D"',
          ]
    if mats: PR.append('IF bKitSurfaces THEN LOCK ' + ', '.join('"%s"' % short[m] for m in mats))
    if clear: PR += ['IF NOT(bShowClearance) THEN LOCK "bClear3D", "penClear", "srfClearance", "clearLabel"']
    PR.append('IF NOT(bCoverFill) THEN LOCK "fillCover", "penFillFg", "penFillBg"')
    PR += ['IF iLOD3D <> 3 THEN LOCK "iRes"']
    PR = [l for l in PR if 'dummy_none' not in l]
    scriptpr = '\n'.join(PR)

    # ---------------- UI script (444 x 296 page)
    U = ['UI_DIALOG "Formcraft · %s"' % fam.replace('FMC_', '').replace('_', ' '),
         'UI_STYLE 0, 0']
    def row(y, label, name, w=200):
        return ['UI_OUTFIELD "%s", 10, %d, 210, 18' % (label, y), 'UI_INFIELD "%s", 225, %d, %d, 20' % (name, y - 2, w)]
    pages = []
    p1 = [('Model detail', 'iLOD3D'), ('Smoothness (Fine)', 'iRes'), ('Show small parts', 'bSmall')]
    for pnm in sorted(set(vis_param[s['name']] for s in body if s['name'] in vis_param)):
        p1.append((pnm, pnm.replace(' ', '_').replace('-', '_')))
    if beam: p1.append(('Show light beam', 'bLightBeam'))
    p1.append(('3D contour pen', 'penModel'))
    pages.append(('Model', p1))
    p2 = [('Plan detail follows scale', 'bAutoLOD2D'), ('Plan detail (by hand)', 'iLOD2D'), ('Contour pen', 'penContour'),
          ('Cover fill', 'bCoverFill'), ('Cover fill type', 'fillCover'), ('Keynote tag at 1:50', 'bShowName')]
    if clear: p2 += [('Show clearance zone', 'bShowClearance'), ('Clearance in 3D', 'bClear3D'), ('Clearance pen', 'penClear'),
                     ('Clearance label', 'clearLabel')]
    pages.append(('Plan', p2))
    p3 = [('Use Formcraft kit surfaces', 'bKitSurfaces')] + [(m.replace('FMC_', '').replace('_', ' ')[:30], short[m]) for m in mats]
    pages.append(('Surfaces', p3))
    p4 = [(n.replace('FMC_', '').replace('_', ' ')[:30], n) for (_, n, _d, _v, fl) in P
          if _ in ('String', 'RealNum') and n not in ('clearLabel',)]
    pages.append(('Data', p4))
    per_page = 10
    split = []
    for title, rows in pages:
        chunks = [rows[i:i + per_page] for i in range(0, len(rows), per_page)] or [[]]
        for ci, ch in enumerate(chunks):
            split.append((title if len(chunks) == 1 else '%s %d/%d' % (title, ci + 1, len(chunks)), ch))
    pages = split
    for pi, (title, rows) in enumerate(pages, 1):
        U.append('UI_PAGE %d, -1, "%s"' % (pi, title))
        U.append('UI_STYLE 1, 1')
        U.append('UI_OUTFIELD "FORMCRAFT  ·  %s", 10, 4, 424, 18' % title.upper())
        U.append('UI_SEPARATOR 10, 24, 434, 24')
        U.append('UI_STYLE 0, 0')
        y = 34
        for i, (lab, nm) in enumerate(rows):
            U += row(y, lab, nm); y += 22
        U.append('UI_SEPARATOR 10, 276, 434, 276')
        U.append('UI_STYLE 1, 0')
        U.append('UI_OUTFIELD "%s", 10, 280, 300, 14' % ('Formcraft Studio · formcraft BIM kit'))
        if pi > 1: U.append('UI_BUTTON UI_PREV, "<", 344, 278, 40, 18')
        if pi < len(pages): U.append('UI_BUTTON UI_NEXT, ">", 394, 278, 40, 18')
        if len(rows) > per_page:
            # overflow rows on a continuation page
            pass
    scriptui = '\n'.join(U)

    master = '! master script: nothing to compute'
    return dict(fam=fam, guid=str(uuid.uuid5(NS, 'formcraft-gdl:' + fam)).upper(), params=P,
                s1d=master, s2d=script2d, s3d=script3d, spr=scriptpr, sui=scriptui,
                size=(A, B, H), counts=dict(parts=len(body), voids=len(voids), mats=len(mats), clear=len(clear)),
                about=d.get('about', ''), tv=tv, ceiling=ceiling, clear_rect=cr, body_rect=br, blo=blo)

# ---------------------------------------------------------------- XML writer
def cdata(s): return '<![CDATA[%s]]>' % s.replace(']]>', ']]]]><![CDATA[>')

def param_xml(t, name, desc, val, flags):
    fl = ''
    f = []
    if 'child' in flags: f.append('<ParFlg_Child/>')
    if 'bold' in flags: f.append('<ParFlg_BoldName/>')
    if f: fl = '\t\t\t\t<Flags>%s</Flags>\n' % ''.join(f)
    fix = '\t\t\t\t<Fix/>\n' if 'fix' in flags else ''
    out = '\t\t\t<%s Name="%s">\n\t\t\t\t<Description>%s</Description>\n%s%s' % (t, name, cdata('"%s"' % desc), fix, fl)
    if t != 'Title':
        if t == 'String': v = cdata('"%s"' % str(val).replace('"', "'"))
        elif t in ('Length', 'RealNum'): v = F(val) if val else '0'
        else: v = str(int(val))
        out += '\t\t\t\t<Value>%s</Value>\n' % v
    out += '\t\t\t</%s>\n' % t
    return out

def to_xml(o):
    sect = lambda tag, body: '\t<%s SectVersion="20" SectionFlags="0" SubIdent="0">%s</%s>\n' % (tag, cdata(body), tag)
    x = ['<?xml version="1.0" encoding="UTF-8"?>\n',
         '<Symbol IsArchivable="false" IsPlaceable="true" MainGUID="%s" MigrationValue="Normal" Owner="0" Signature="0" Version="44">\n' % o['guid'],
         '\t<Ancestry SectVersion="1" SectionFlags="0" SubIdent="0" Template="false">\n',
         '\t\t<MainGUID>F938E33A-329D-4A36-BE3E-85E126820996</MainGUID>\n',
         '\t\t<MainGUID>103E8D2C-8230-42E1-9597-46F84CCE28C0</MainGUID>\n',
         '\t</Ancestry>\n',
         '\t<CalledMacros SectVersion="2" SectionFlags="0" SubIdent="0">\n\t</CalledMacros>\n',
         '\t<ParamSection SectVersion="27" SectionFlags="0" SubIdent="0">\n',
         '\t\t<ParamSectHeader>\n\t\t\t<AutoHotspots>false</AutoHotspots>\n\t\t\t<StatBits>\n\t\t\t\t<STBit_FixSize/>\n\t\t\t</StatBits>\n'
         '\t\t\t<WDLeftFrame>0</WDLeftFrame>\n\t\t\t<WDRightFrame>0</WDRightFrame>\n\t\t\t<WDTopFrame>0</WDTopFrame>\n\t\t\t<WDBotFrame>0</WDBotFrame>\n'
         '\t\t\t<LayFlags>65535</LayFlags>\n\t\t\t<WDMirrorThickness>0</WDMirrorThickness>\n\t\t\t<WDWallInset>0</WDWallInset>\n\t\t</ParamSectHeader>\n',
         '\t\t<Parameters>\n']
    for p in o['params']: x.append(param_xml(*p))
    x.append('\t\t</Parameters>\n\t</ParamSection>\n')
    x.append(sect('Script_1D', o['s1d']))
    x.append(sect('Script_2D', o['s2d']))
    x.append(sect('Script_3D', o['s3d']))
    x.append(sect('Script_PR', ''))
    x.append(sect('Script_UI', o['sui']))
    x.append(sect('Script_VL', o['spr']))
    x.append('\t<Comment SectVersion="20" SectionFlags="0" SubIdent="0">%s</Comment>\n' % cdata(
        'Formcraft Studio · %s · Coarse LOD 200, Medium LOD 300, Fine LOD 400. Generated from the Formcraft recipe; kit surfaces inline.' % o['fam']))
    x.append('\t<Keywords SectVersion="1" SectionFlags="0" SubIdent="0">%s</Keywords>\n' % cdata('Formcraft hospital medical equipment ' + o['fam']))
    x.append('</Symbol>\n')
    return ''.join(x)

if __name__ == '__main__':
    import check
    out = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/gdl/out'
    os.makedirs(out, exist_ok=True)
    for f in check.FAMS:
        o = build(check.base + f + '.recipe.json', '/mnt/user-data/uploads/07_Materials/FMC_Materials.json', out)
        name = o['fam'] + '.xml'
        open(os.path.join(out, name), 'w', encoding='utf-8').write(to_xml(o))
        print(name, o['counts'], ['%.0f' % v for v in o['size']], 'lines3d', o['s3d'].count('\n'))
