"""The patches applied by hand to the hospital sample's batch files on 19 Oct 2026, kept so they can be repeated or
reviewed. Each was a workaround for a plugin gap; the gap and its fix are in docs/handoff/catalog_session/REPORT.md.

  1. run copies without size_mm on import_part   (the old add-in refused smooth parts ~2% bigger; fixed in #224)
  2. lever rose: add_type before set_formula     (generator bug; fixed in #228)
     pass box top and base: one plane per slab   (generator bug; fixed in #228)
  3. lever rose types renamed to [KeySize]_[Variant] (52_ArmLeft, 52_ArmRight), in the rose and both doors (fixed in #228)

usage: python batch_patches.py <step 1|2|3>, run in <staging>\\_Batch (the original is kept in _Archive first)
"""
import json, sys

DET, QS = "batch_DET_LOD400.json", "batch_QS03_SAMPLE_LOD400.json"


def load(f): return json.load(open(f, encoding="utf-8-sig"))
def save(f, d): json.dump(d, open(f, "w", encoding="utf-8"), indent=1)


def step1():
    for src, dst in ((DET, "batch_DET_LOD400_run.json"), (QS, "batch_QS03_SAMPLE_LOD400_run.json")):
        d = load(src)
        for r in d:
            for o in r.get("ops", []):
                if o.get("op") == "import_part": o.pop("size_mm", None)
        save(dst, d)


def step2():
    for f in (QS, "batch_QS03_SAMPLE_LOD400_run.json"):
        d = load(f)
        for r in d:
            ops = r["ops"]
            if r["family"] == "FMC_A_Part_LeverRose":
                t = ops.pop(next(k for k, o in enumerate(ops) if o["op"] == "add_type" and o["name"] == "Arm Left"))
                ops.insert(next(k for k, o in enumerate(ops) if o["op"] == "set_formula"), t)
            for o in ops:
                if o.get("op") == "extrusion" and o.get("start_plane") and o.get("start_plane") == o.get("end_plane"):
                    o.pop("start_plane" if o["name"] == "Pass Box Top" else "end_plane")
        save(f, d)


def step3():
    ren = {"Arm Left": "52_ArmLeft", "Arm Right": "52_ArmRight"}
    def fix(v):
        if isinstance(v, str):
            if v in ren: return ren[v]
            for a, b in ren.items():
                if v.startswith(a + "/"): return b + v[len(a):]
            return v
        if isinstance(v, list): return [fix(x) for x in v]
        if isinstance(v, dict): return {k: fix(x) for k, x in v.items()}
        return v
    for f in (QS, "batch_QS03_SAMPLE_LOD400_run.json"):
        d = load(f)
        for r in d:
            if r["family"] in ("FMC_A_Part_LeverRose", "FMC_A_Door_FlushSingle_Hygienic_Detailed", "FMC_A_Door_LeadLined_Xray_Detailed"):
                r["ops"] = fix(r["ops"])
        save(f, d)


{"1": step1, "2": step2, "3": step3}[sys.argv[1]]()
