"""Adds kit materials, type keynotes, FMC_Design_Movement and a trim profile slot to the door and window recipes.

    python tests/recipes/_gen/gen_profile_slots.py --kit <kit folder>

Runs on the recipes in tests/recipes (the windows come from gen_windows.py; run that first if you regenerate them). The
geometry ops are kept as they are; everything this script adds is stripped first, so a second run gives the same file.

Profile slot (owner, 15 Oct 2026: one set of profiles per design movement, switched by a shared parameter):
  - FMC_Design_Movement (kit shared parameter, Integer, instance), default 17 Contemporary;
  - per movement n = 1..20 (FMC_Profile_Sets.json order): load_family FMC_Profile_<Element>_<Token> by a path relative
    to the kit's family staging root (_Profiles\\<family>.rfa, resolved on the build PC), a Yes/No instance parameter
    Show_<Token> = (FMC_Design_Movement = n), and one sweep per trimmed face along the opening's jambs and head, its
    Visible bound to Show_<Token>;
  - doors take the Architrave element on both faces, windows the Surround on the exterior face.

Fully parametric (owner's standard): every sweep's path is path_planes, corners on the family's own planes (Left,
Right, the head plane and the sill or floor plane), so the trims follow Width, Height and Fanlight Height. The path
sketch is hosted on the face plane: Frame Ext/Int where the trim sits on the frame, else Trim Face Ext/Int, placed by
Trim Face Offset from Wall Centre. The flush door's swept frame gets the same (BASE_SWEEPS). Type 1 and its Width and
Height come before the first reference plane (size first, F-026).
Materials come from 07_Materials/FMC_Materials.json and keynotes from 02_Keynotes/FMC_Keynotes.txt; the script stops if a
name or code isn't in the kit (rule 7). Coordinates are rounded to 10 decimals (F-027).
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECIPES = HERE.parent
DEFAULT_MOVEMENT = 17  # Contemporary: the canvas boards' default; FMC_Profile_Sets.json has no default (kit change request)
WALL_FACE = 130.0  # 230 wall + 15 plaster each side, as the window sills in gen_windows.py
MARK = " Profile slot (gen_profile_slots.py):"

TRIM_FACE = "Trim Face Offset"  # Length, type: Wall Centre to the trimmed wall face (assumed 130)

# Per family: profile element, the path's bottom and top planes (the planes Height is measured between), faces
# [(label, host plane, y of the face, path reversed)] (a host plane the recipe doesn't draw is added at y, placed by
# Trim Face Offset), material per parameter (the first parameter that takes a material gets add_material; a later
# parameter with the same material gets a formula), keynote per type (first match on the type name; "" = every type)
# and why.
FAMILIES = {
    "FMC_A_Door_FlushSingleLeaf": dict(
        kind="door", element="Architrave", bottom="Ref. Level", top="Head",
        faces=[("Ext", "Trim Face Ext", -WALL_FACE, False), ("Int", "Trim Face Int", WALL_FACE, True)],
        materials=[("Frame Material", "FMC_Timber_Mvule"), ("Leaf Material", "FMC_Timber_Mahogany"),
                   ("Trim Material", "FMC_Timber_Mvule")],
        keynotes=[("", "D.FLU_00")],
        keynote_note="D.FLU_00 45 mm solid-core flush, Mahogany: matches the 45 mm leaf; solid core not confirmed",
        wall_note="wall faces at y = -/+130 (230 wall + 15 plaster), the frame is 100 deep: Trim Face Ext/Int, "
                  "Trim Face Offset from Wall Centre"),
    "FMC_A_Door_TimberFanlight": dict(
        kind="door", element="Architrave", bottom="Floor", top="Frame Head",
        faces=[("Ext", "Frame Ext", -100.0, False), ("Int", "Frame Int", 100.0, True)],
        materials=[("Frame Material", "FMC_Timber_Mvule"), ("Leaf Material", "FMC_Timber_Mahogany"),
                   ("Glass Material", "FMC_Glass_Clear"), ("Louvre Material", "FMC_Timber_Mvule"),
                   ("Mesh Material", "FMC_Plastic_InsectMesh_Fibreglass"), ("Hardware Material", "FMC_Metal_Chrome_Polished"),
                   ("Trim Material", "FMC_Timber_Mvule")],
        keynotes=[("Panel", "D.PAN_00"), ("Mahogany", "D.PAN_00"), ("", "D.FLU_01")],
        keynote_note=("flush types D.FLU_01 (40 mm solid-core flush, Mvule), panelled types D.PAN_00 (45 mm panelled "
                      "Mahogany; this leaf is 40): leaf codes, the kit has no fanlight doorset code"),
        wall_note="trim on the frame faces Frame Ext/Int (y = -/+100, 8 in frame = wall depth, Frame Depth), where the "
                  "plain 60x15 architrave sits",
        plain_trim=["Architrave Ext L", "Architrave Ext R", "Architrave Ext Head",
                    "Architrave Int L", "Architrave Int R", "Architrave Int Head"]),
    "FMC_A_Door_SteelFanlight": dict(
        kind="door", element="Architrave", bottom="Floor", top="Frame Head",
        faces=[("Ext", "Trim Face Ext", -WALL_FACE, False), ("Int", "Trim Face Int", WALL_FACE, True)],
        materials=[("Frame Material", "FMC_Metal_SteelLTZ_Painted"), ("Leaf Material", "FMC_Metal_SteelLTZ_Painted"),
                   ("Glass Material", "FMC_Glass_Clear"), ("Louvre Material", "FMC_Metal_SteelLTZ_Painted"),
                   ("Mesh Material", "FMC_Plastic_InsectMesh_Fibreglass"), ("Hardware Material", "FMC_Metal_Chrome_Polished"),
                   ("Trim Material", "FMC_Timber_Mvule")],
        keynotes=[("", "D.MET_00")],
        keynote_note=("D.MET_00 45 mm steel flush door, powder coated: the nearest steel door code; this is an 18g sheet "
                      "leaf on RHS, painted, with a vent over (kit change request for a steel fanlight doorset)"),
        wall_note="wall faces at y = -/+130 (230 wall + 15 plaster), the RHS frame is 40 deep: Trim Face Ext/Int, "
                  "Trim Face Offset from Wall Centre"),
    "FMC_A_Window_SteelCasementVent": dict(
        kind="window", element="Surround", bottom="Sill", top="Head",
        faces=[("Ext", "Trim Face Ext", -WALL_FACE, False)],
        materials=[("Frame Material", "FMC_Metal_SteelLTZ_Painted"), ("Glass Material", "FMC_Glass_Clear"),
                   ("Mesh Material", "FMC_Plastic_InsectMesh_Fibreglass"), ("Sill Material", "FMC_Concrete_Precast_Painted"),
                   ("Trim Material", "FMC_Concrete_Precast_Painted")],
        keynotes=[("", "G.STL_00")],
        keynote_note="G.STL_00 steel casement window in LTZ/Z-T sections, primed and gloss painted",
        wall_note="exterior wall face at y = -130 (230 wall + 15 plaster), as the sill: Trim Face Ext, Trim Face Offset "
                  "from Wall Centre"),
    "FMC_A_Window_AluVent": dict(
        kind="window", element="Surround", bottom="Sill", top="Head",
        faces=[("Ext", "Trim Face Ext", -WALL_FACE, False)],
        materials=[("Frame Material", "FMC_Metal_Aluminium_PowderCoated"), ("Glass Material", "FMC_Glass_Clear"),
                   ("Mesh Material", "FMC_Plastic_InsectMesh_Fibreglass"), ("Sill Material", "FMC_Concrete_Precast_Painted"),
                   ("Trim Material", "FMC_Concrete_Precast_Painted")],
        keynotes=[("Sliding", "G.SLD_00"), ("", "G.CAS_00")],
        keynote_note=("casement and PJ types G.CAS_00, sliding types G.SLD_00; both kit codes say double glazed and this is "
                      "5 mm single glazing (kit change request for single-glazed aluminium codes)"),
        wall_note="exterior wall face at y = -130 (230 wall + 15 plaster), as the sill: Trim Face Ext, Trim Face Offset "
                  "from Wall Centre"),
}

# Sweeps in the base recipes made parametric here: the flush door's frame runs 20 mm inside Left, Right and Head (half
# its 40 mm profile) on the wall centre. Its face locks to Left/Right go: the path's own locks replace them.
BASE_SWEEPS = {
    "FMC_A_Door_FlushSingleLeaf": {
        "Frame": dict(path_planes=[["Left", "Ref. Level"], ["Left", "Head"], ["Right", "Head"], ["Right", "Ref. Level"]],
                      path_offsets=[20, -20, -20], path_host="Wall Centre"),
    },
}
BASE_DROP = {"FMC_A_Door_FlushSingleLeaf": [("lock_face", "Frame/Left"), ("lock_face", "Frame/Right")]}


def r10(v):
    return round(float(v), 10)


def kit_data(kit):
    sets = json.loads((kit / "03_Master_Data" / "FMC_Profile_Sets.json").read_text(encoding="utf-8"))
    mats = {m["name"]: m for m in json.loads((kit / "07_Materials" / "FMC_Materials.json").read_text(encoding="utf-8"))["materials"]}
    codes = {}
    for ln in (kit / "02_Keynotes" / "FMC_Keynotes.txt").read_text(encoding="utf-8").splitlines():
        b = ln.split("\t")
        if len(b) >= 2 and "_" in b[0]:
            codes[b[0]] = b[1]
    guid = None
    for ln in (kit / "01_Shared_Parameters" / "FMC_SharedParameters.txt").read_text(encoding="utf-8").splitlines():
        b = ln.split("\t")
        if b[0] == "PARAM" and b[2] == "FMC_Design_Movement":
            guid = b[1]
    if not guid:
        sys.exit("FMC_Design_Movement isn't in the kit's shared parameter file")
    return sets, mats, codes, guid


def profile_type(row):
    """The profile family's one type, as build_profile_recipes.py names it: height x projection in mm."""
    return f"{row['height']}x{row['projection']}"


def slot_ops(rec, cfg, sets, mats, codes, guid):
    ops = rec["ops"]
    types = [o["name"] for o in ops if o["op"] == "add_type"]
    add = []
    A = add.append

    # the face planes the trim paths sit on: the recipe's own (Frame Ext/Int), or Trim Face Ext/Int (this script's),
    # placed by Trim Face Offset from Wall Centre (a labelled dimension each side, so the trims move with it)
    new_faces = [(host, y) for _, host, y, _ in cfg["faces"] if host.startswith("Trim Face")]
    if new_faces:
        A({"op": "add_family_param", "name": TRIM_FACE, "type": "Length", "instance": False, "group": "Dimensions"})
        for host, y in new_faces:
            A({"op": "add_ref_plane", "name": host, "from": [-2000, r10(y)], "to": [2000, r10(y)], "is_reference": "WeakReference"})
            A({"op": "add_dimension", "name": f"{TRIM_FACE} {host.split()[-1]}", "between": ["Wall Centre", host],
               "label": TRIM_FACE, "offset": 900})

    # shared switch and materials
    A({"op": "add_shared_param", "name": "FMC_Design_Movement", "guid": guid, "instance": True, "group": "Graphics"})
    A({"op": "add_family_param", "name": "Trim Material", "type": "Material", "instance": False, "group": "Materials"})
    first = {}
    for param, mat in cfg["materials"]:
        if mat not in mats:
            sys.exit(f"{rec['family']}: material {mat} isn't in FMC_Materials.json")
        if mats[mat].get("keynote") and mats[mat]["keynote"] not in codes:
            print(f"warning: {mat} carries keynote {mats[mat]['keynote']}, which isn't in FMC_Keynotes.txt")
        if mat in first:
            # one add_material per material (op names are unique per batch); the next parameter follows the first
            A({"op": "set_formula", "name": param, "formula": first[mat]})
        else:
            A({"op": "add_material", "name": mat, "param": param})
            first[mat] = param

    # the slot: one profile family, switch and sweep(s) per movement
    el = cfg["element"]
    rows = sorted((r for r in sets if r["element"] == el), key=lambda r: r["index"])
    if len(rows) != 20:
        sys.exit(f"FMC_Profile_Sets.json has {len(rows)} {el} profiles, expected 20")
    lo, hi = cfg["bottom"], cfg["top"]
    corners = [["Left", lo], ["Left", hi], ["Right", hi], ["Right", lo]]
    for row in rows:
        tok, fam = row["token"], row["family"]
        show = f"Show_{tok}"
        # relative to the kit's family staging root: the engine finds it on the build PC (Z:, D:, …)
        A({"op": "load_family", "name": fam, "path": f"_Profiles\\{fam}.rfa"})
        A({"op": "add_family_param", "name": show, "type": "YesNo", "instance": True, "group": "Graphics"})
        A({"op": "set_formula", "name": show, "formula": f"FMC_Design_Movement = {row['index']}"})
        for face, host, _, rev in cfg["faces"]:
            solid = f"{el} {tok} {face}"
            A({"op": "sweep", "name": solid, "path_planes": [list(c) for c in (corners[::-1] if rev else corners)],
               "path_host": host, "path_plane": "front", "profile_family": fam, "profile_type": profile_type(row),
               "subcategory": "Frame"})
            A({"op": "set_material_param", "name": solid, "param": "Trim Material"})
            A({"op": "set_visibility", "name": solid, "coarse": False, "medium": True, "fine": True})
            A({"op": "set_visible_param", "name": f"{solid}/Visible", "solid": solid, "param": show})

    # the plain trim the recipe already draws shows only when no movement is chosen
    if cfg.get("plain_trim"):
        A({"op": "add_family_param", "name": "Show_Plain_Trim", "type": "YesNo", "instance": True, "group": "Graphics"})
        A({"op": "set_formula", "name": "Show_Plain_Trim", "formula": "or(FMC_Design_Movement < 1, FMC_Design_Movement > 20)"})
        for s in cfg["plain_trim"]:
            A({"op": "set_visible_param", "name": f"{s}/Visible", "solid": s, "param": "Show_Plain_Trim"})

    # per type: keynote (FAM-017: Keynote = FMC_Keynote_Code) and the default movement
    for t in types:
        code = next(c for key, c in cfg["keynotes"] if key in t)
        if code not in codes:
            sys.exit(f"{rec['family']}: keynote {code} isn't in FMC_Keynotes.txt")
        A({"op": "set_type_value", "name": f"{t}/Keynote", "type": t, "param": "Keynote", "value": code})
        A({"op": "set_type_value", "name": f"{t}/FMC_Keynote_Code", "type": t, "param": "FMC_Keynote_Code", "value": code})
        A({"op": "set_type_value", "name": f"{t}/FMC_Design_Movement", "type": t, "param": "FMC_Design_Movement",
           "value": DEFAULT_MOVEMENT})
        if new_faces:
            A({"op": "set_type_value", "name": f"{t}/{TRIM_FACE}", "type": t, "param": TRIM_FACE, "value": WALL_FACE})

    values = {
        "Keynote": {"value": ", ".join(sorted({c for _, c in cfg["keynotes"]})), "source_status": "assumed",
                    "source": cfg["keynote_note"]},
        "Materials (kit library)": {"value": "; ".join(f"{p} = {m}" for p, m in cfg["materials"]), "source_status": "assumed",
                                    "source": "FMC_Materials.json; chosen for the family, the reviewer confirms"},
        "Design movement default 17 (Contemporary)": {"value": DEFAULT_MOVEMENT, "source_status": "assumed",
                                                      "source": "canvas boards; FMC_Profile_Sets.json has no default"},
        f"{el} profiles: 20 movements": {"value": f"FMC_Profile_{el}_<Token>", "source_status": "assumed",
                                         "source": "FMC_Profile_Sets.json (outlines proposed for the designer to approve)"},
        "Trim position": {"value": "jambs and head at the opening edge", "source_status": "assumed", "source": cfg["wall_note"]},
    }
    if new_faces:
        values[TRIM_FACE] = {"value": WALL_FACE, "source_status": "assumed",
                             "source": "230 wall + 15 plaster each side; set it per type for other walls"}
    faces = " and ".join(f for f, _, _, _ in cfg["faces"])
    hosts = "/".join(h for _, h, _, _ in cfg["faces"])
    about = (f"{MARK} FMC_Design_Movement (1-20, default {DEFAULT_MOVEMENT}) shows one of 20 {el} sweeps "
             f"({faces} face{'s' if len(cfg['faces']) > 1 else ''}) from FMC_Profile_{el}_<Token>, each bound to Show_<Token>. "
             f"Each sweep's path is locked to Left, Right, {cfg['top']} and {cfg['bottom']} (path_planes) on {hosts}, so the "
             "trims follow Width and Height in every type.")
    if cfg.get("plain_trim"):
        about += " The plain architrave shows only when FMC_Design_Movement is outside 1-20."
    return add, values, about


def strip(rec, keys):
    """Remove what an earlier run added: ops by (op, name), the about sentence and our value rows."""
    rec["ops"] = [o for o in rec["ops"] if (o["op"], o["name"]) not in keys]
    rec["about"] = rec["about"].split(MARK)[0]


def base_fixes(rec):
    """Base-recipe sweeps on path_planes (BASE_SWEEPS) and the face locks they replace (BASE_DROP); idempotent."""
    fam = rec["family"]
    drop = set(BASE_DROP.get(fam, []))
    rec["ops"] = [o for o in rec["ops"] if (o["op"], o["name"]) not in drop]
    for o in rec["ops"]:
        fix = BASE_SWEEPS.get(fam, {}).get(o["name"]) if o["op"] in ("sweep", "void_sweep") else None
        if fix:
            for k in ("path", "at"):
                o.pop(k, None)
            o.update(json.loads(json.dumps(fix)))


def size_first(ops):
    """Type 1 and its Width and Height before the first reference plane (F-026), as gen_windows.py does: labelled
    dimensions take their value from where the planes sit, so the template's default size must not be current."""
    t1 = next(o for o in ops if o["op"] == "add_type")["name"]
    early = [o for o in ops if o["op"] == "add_type" and o["name"] == t1]
    early += [o for o in ops if o["op"] == "set_type_value" and o["type"] == t1 and o["param"] in ("Width", "Height")]
    rest = [o for o in ops if not any(o is e for e in early)]
    i = next(k for k, o in enumerate(rest) if o["op"] == "add_ref_plane")
    return rest[:i] + early + rest[i:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kit", required=True, type=Path)
    a = ap.parse_args()
    sets, mats, codes, guid = kit_data(a.kit)
    for fam, cfg in FAMILIES.items():
        f = RECIPES / f"{fam}.recipe.json"
        raw = f.read_text(encoding="utf-8")
        rec = json.loads(raw)
        indent = next((i for i in (1, 2) if json.dumps(rec, indent=i) == raw), 1)
        base_fixes(rec)
        # first pass to learn the keys this script owns, then strip and add again (idempotent)
        add, _, _ = slot_ops(rec, cfg, sets, mats, codes, guid)
        keys = {(o["op"], o["name"]) for o in add}
        strip(rec, keys)
        add, values, about = slot_ops(rec, cfg, sets, mats, codes, guid)
        rec["ops"] = size_first(rec["ops"] + add)
        rec["about"] = rec["about"] + about
        rec["values"].update(values)
        f.write_text(json.dumps(rec, indent=indent), encoding="utf-8")
        print(fam, len(rec["ops"]), "ops,", len(add), "added")


if __name__ == "__main__":
    main()
