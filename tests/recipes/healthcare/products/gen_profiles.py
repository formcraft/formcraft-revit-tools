"""The 4 healthcare profile families (2D sweep sections, Metric Profile.rft), drawn with profile_lines.
x = projection from the wall (mm), y = up. Sizes are typical, marked assumed. Run: python3 gen_profiles.py"""
import json, os
from PIL import Image, ImageDraw
HERE = os.path.dirname(os.path.abspath(__file__))
A = lambda v, why: {"value": v, "source_status": "assumed", "source": why}
S = lambda p, q=None: ({"to": p, "through": q} if q else {"to": p})
PROF = [
 ("FMC_A_Profile_HygienicCoving_Floor", "100x38_Cove", "Sheet vinyl turned up the wall over a 38 mm cove former, 100 mm high",
  [0, 100], [S([0, 38]), S([38, 0], [11.13, 11.13]), S([150, 0]), S([150, 2.5]), S([38, 2.5]), S([2.5, 38], [12.9, 12.9]), S([2.5, 100])],
  {"Cove radius 38 mm": A(38, "HBN 00-10 Part A: coved junctions"), "Turn-up 100 mm": A(100, "HBN 00-10 Part A")}),
 ("FMC_A_Profile_CrashRail_Section", "200x25_Vinyl", "Crash rail: 200 mm vinyl-faced buffer over an aluminium retainer, 25 mm deep",
  [0, 0], [S([5, 0]), S([25, 12]), S([25, 188]), S([5, 200]), S([0, 200])],
  {"Height 200 mm": A(200, "typical bed/trolley crash rail"), "Projection 25 mm": A(25, "typical")}),
 ("FMC_A_Profile_Handrail_Hospital_Section", "140x45_Handrail", "Combined handrail and buffer, 140 mm high, 45 mm projection, hand-grip top",
  [0, 0], [S([15, 0]), S([40, 15]), S([45, 40]), S([45, 100]), S([40, 125], [44, 114]), S([15, 140], [30, 136]), S([0, 140])],
  {"Height 140 mm": A(140, "typical hospital handrail-buffer"), "Grip 45 mm": A(45, "BS 8300: 32-50 mm grip")}),
 ("FMC_A_Profile_Nosing_StairAntiSlip", "55x30_Nosing", "Aluminium stair nosing 55 x 30 mm with an anti-slip insert channel",
  [0, 0], [S([55, 0]), S([55, 3]), S([10, 3]), S([10, 8]), S([4, 8]), S([4, 30]), S([0, 30])],
  {"Tread 55 mm": A(55, "BS 8300 / Approved Doc K: 50-65 mm"), "Riser 30 mm": A(30, "BS 8300: 30-55 mm")}),
]
for fam, tname, desc, start, segs, values in PROF:
    segs = segs + [S(list(start))]
    ops = [{"op": "add_type", "name": tname}, {"op": "set_type_value", "name": f"{tname}/Description", "type": tname, "param": "Description", "value": desc},
           {"op": "profile_lines", "name": "Section", "start": start, "segments": segs}]
    r = {"schema": "fmc-recipe/0.1", "family": fam, "template": "Metric Profile.rft", "about": desc + ". A 2D profile for sweeps (rails, coving, nosings); never scheduled.",
         "ops": ops, "values": values, "checks": {"keynote_exempt": "profile family: used inside sweeps, never scheduled"}}
    json.dump(r, open(os.path.join(HERE, fam + '.recipe.json'), 'w'), indent=1)
    # preview: the section, 4 px per mm
    pts = [start] + [s['to'] for s in segs]; k = 4; xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    W, H = int(max(xs) * k) + 80, int(max(ys) * k) + 80
    im = Image.new('RGB', (W, H), 'white'); d = ImageDraw.Draw(im)
    d.polygon([(40 + x * k, H - 40 - y * k) for x, y in pts], fill=(184, 192, 200), outline=(30, 34, 40))
    d.line([(38, 10), (38, H - 10)], fill=(150, 70, 70), width=2); d.text((44, 10), fam + "  " + tname, fill=(20, 24, 30))
    im.save(os.path.join(HERE, fam + '.preview.png')); im.save(os.path.join(HERE, fam + '.png'))
    print(fam, len(ops))
