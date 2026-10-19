"""Turn a staged fmc-recipe into its LOD 400 version: native solids drop to Coarse/Medium, Rhino parts (import_part) show at Fine.
usage: python3 make_lod400.py spec.json  -> writes <family>.lod400.recipe.json beside it
spec: {family, parts:[{name, subcategory, material_param, size_mm, visible_param?}], demote:[solid names], extra_ops:[...], about}"""
import json, sys, copy, os
RH = r"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\04_Families\_Staging\_Rhino"

def make(spec, here):
    fam = spec["family"]
    r = json.load(open(os.path.join(here, fam + ".recipe.json")))
    ops = copy.deepcopy(r["ops"])
    # connectors must stay last-ish: split them off and re-append after our ops
    tail = [o for o in ops if o["op"] in ("add_connector", "link_connector_param")]
    ops = [o for o in ops if o not in tail]
    ops += spec.get("extra_ops", [])
    for s in spec.get("demote", []):
        hit = [o for o in ops if o["op"] == "set_visibility" and o["name"] == s]
        if hit:
            for o in hit: o.update({"coarse": False, "medium": True, "fine": False})
        else:
            ops.append({"op": "set_visibility", "name": s, "coarse": False, "medium": True, "fine": False})
    for p in spec["parts"]:
        n = p["name"] + " Fine"
        ops.append({"op": "import_part", "name": n, "file": f"{RH}\\{fam}\\{p['name']}.3dm"})
        ops.append({"op": "set_subcategory", "name": n, "subcategory": p["subcategory"]})
        if p.get("material_param"):
            ops.append({"op": "set_material_param", "name": n, "param": p["material_param"]})
        ops.append({"op": "set_visibility", "name": n, "coarse": False, "medium": False, "fine": True})
        if p.get("visible_param"):
            ops.append({"op": "set_visible_param", "name": n + "/Visible", "solid": n, "param": p["visible_param"]})
    ops += tail
    r["ops"] = ops
    r["about"] = r.get("about", "") + " | LOD 400: " + spec.get("about", "Rhino 8 smooth parts at Fine, native solids at Coarse/Medium")
    r.setdefault("values", {})["LOD 400 geometry"] = {"value": "Rhino parts", "source_status": "assumed", "source": "Formcraft design, Kisasi 19 Oct 2026; maker drawings to confirm"}
    out = os.path.join(here, fam + ".lod400.recipe.json")
    json.dump(r, open(out, "w"), indent=1)
    return out, len(ops)

if __name__ == "__main__":
    spec = json.load(open(sys.argv[1]))
    for s in (spec if isinstance(spec, list) else [spec]):
        print(make(s, os.path.dirname(os.path.abspath(sys.argv[1]))))
