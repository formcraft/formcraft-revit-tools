# One command for a design that keeps changing (owner 28 Oct): read the models again, re-analyse, redesign, re-check,
# audit, test the redundancy, rebuild the reports, and say what changed since the last update. Nothing is written to
# Revit here (sizes go to Revit with revit-apply.mjs after a look at the summary).
#   python scripts/structure/update.py <project 01_WIP> [--no-revit] [--robot]
#   --no-revit: use the facts already on disk (Revit closed); --robot: also run the final model in Robot (slow)
# Steps and their outputs (all in _Structure/_work unless said):
#   1 facts.json (architect's link: walls, openings, floors, rooms) and facts_now.json (the structural model)
#   2 analysis + member sizing to convergence (iterate.sh), then rc-design.py until no column changes size
#   3 extra-checks.py, model-audit.py, infill-diff.py (structural walls changed?), the bare-frame redundancy run
#   4 report_visual.py, review_pack.py; update_summary.json + a printed summary of what changed
import json, os, sys, shutil, subprocess, datetime, re
WIP = sys.argv[1]; NOREV = "--no-revit" in sys.argv; ROBOT = "--robot" in sys.argv
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); SC = os.path.join(REPO, "scripts")
S = os.path.join(WIP, "_Structure"); W = os.path.join(S, "_work"); O = os.path.join(S, "Robot"); MESH = os.path.join(WIP, "_Report", "mesh")
J = lambda p, d=None: json.load(open(p, encoding="utf-8")) if os.path.exists(p) else d
cfg = J(W + "/config.json", {}); log = []
def run(args, timeout=900, ok_codes=(0,)):
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, cwd=REPO)
    out = (r.stdout or "") + (r.stderr or ""); log.append({"cmd": " ".join(os.path.basename(a) for a in args[:3]), "code": r.returncode, "tail": out[-600:]})
    if r.returncode not in ok_codes: print(out[-1500:]); raise SystemExit(f"step failed: {' '.join(args[:3])}")
    return out
py = [sys.executable]; node = ["node"]; bash = [shutil.which("bash") or "bash"]
snap = {k: J(W + f"/{k}.json") for k in ("sizes", "infill", "extra_checks", "model_audit")}
design0 = J(sorted([os.path.join(S, f) for f in os.listdir(S) if f.endswith("_rc_design.json")])[-1]) if any(f.endswith("_rc_design.json") for f in os.listdir(S)) else None

# 1 facts
if not NOREV:
    for f in ("facts.json", "facts_now.json"):
        if os.path.exists(os.path.join(W, f)): shutil.copy(os.path.join(W, f), os.path.join(W, f.replace(".json", ".prev.json")))
    run(node + [SC + "/structure/revit-cmd-save.mjs", "fmc_struct_facts", json.dumps({"link": cfg.get("arch_link", "OGL_A_MainHouse_GF_LOD400")}), W + "/facts.json"], 600)
    run(node + [SC + "/structure/revit-facts.mjs", W + "/facts_now.json"], 600)
    run(node + [SC + "/structure/revit-cmd.mjs", "fmc_scene_export", json.dumps({"view": "WEB structure 3D", "folder": MESH, "name": "structure", "format": "obj"})], 600)
    run(py + ["-I", SC + "/project/obj2web.py", MESH + "/structure.obj", MESH + "/structure.web.json"])
# 2 analysis and design to a fixed point
for k in range(5):
    out = run(bash + [SC + "/structure/iterate.sh", W, O, "6"], 1800, ok_codes=(0, 1))
    runid = open(W + "/last_run.txt").read().strip()
    d = run(py + [SC + "/structure/rc-design.py", W, O, runid, S], 900)
    if "run the analysis again" not in d: break
drift = re.findall(r"drift GF storey ([\d.]+) mm \(limit (\d+)\), FF storey ([\d.]+) mm \(limit (\d+)\)", out)
DJ = sorted([os.path.join(S, f) for f in os.listdir(S) if f.endswith("_rc_design.json")])[-1]
# 3 checks, audit, structural walls, redundancy
run(py + ["-I", SC + "/structure/extra-checks.py", W, O, DJ])
run(py + ["-I", SC + "/structure/model-audit.py", W, O, MESH + "/structure.obj", W + "/facts_now.json"])
inf = run(py + ["-I", SC + "/structure/infill-diff.py", W])
# redundancy (owner 28 Oct): the bare frame (no walls) must carry gravity and wind on its own; each member takes the
# larger of the two needs (sizes.json grows, column steel goes to rho_min.json), then the main design runs again
B = os.path.join(S, "_work_bare")
for rr in range(4):
    shutil.rmtree(B, ignore_errors=True); shutil.copytree(W, B); [os.remove(os.path.join(B, f)) for f in (".iterate.lock",) if os.path.exists(os.path.join(B, f))]
    cb = J(B + "/config.json", {}); cb.update({"infill": False, "gravity_wind_only": True}); json.dump(cb, open(B + "/config.json", "w"))
    ro = run(node + [SC + "/structure/robot-run.mjs", B, os.path.join(S, "Robot_bare"), "local"], 600)
    rb = re.search(r'"run":"([^"]+)"', ro).group(1)
    mc = run(py + ["-I", SC + "/structure/member-check.py", B, os.path.join(S, "Robot_bare"), rb])
    over = int(re.search(r"over capacity (\d+)", mc).group(1))
    if over == 0: break
    sz, bs = J(W + "/sizes.json", {}), J(B + "/sizes.json", {}); rm, br = J(W + "/rho_min.json", {}), J(B + "/rho.json", {})
    for k, v in bs.items():
        if v[0] * v[1] > sz.get(k, [0, 0])[0] * sz.get(k, [0, 0])[1]: sz[k] = v
    for k, v in br.items(): rm[k] = max(rm.get(k, 0), v)
    json.dump(sz, open(W + "/sizes.json", "w")); json.dump(rm, open(W + "/rho_min.json", "w"))
    for k in range(5):   # main design again with the bigger needs
        out = run(bash + [SC + "/structure/iterate.sh", W, O, "6"], 1800, ok_codes=(0, 1)); runid = open(W + "/last_run.txt").read().strip()
        d = run(py + [SC + "/structure/rc-design.py", W, O, runid, S], 900)
        if "run the analysis again" not in d: break
    drift = re.findall(r"drift GF storey ([\d.]+) mm \(limit (\d+)\), FF storey ([\d.]+) mm \(limit (\d+)\)", out) or drift
    run(py + ["-I", SC + "/structure/extra-checks.py", W, O, DJ]); run(py + ["-I", SC + "/structure/model-audit.py", W, O, MESH + "/structure.obj", W + "/facts_now.json"])
# 4 reports
run(py + [SC + "/structure/report_visual.py", W, O, DJ, os.path.join(S, "img"), os.path.join(S, datetime.date.today().strftime("%Y%m%d") + "_structural_design_report_visual.html")], 900)
run(py + ["-I", SC + "/structure/review_pack.py", W, O, DJ, os.path.join(S, datetime.date.today().strftime("%Y%m%d") + "_OGL_engineer_review.html")])
if ROBOT: run(bash + [W + "/robot_verify.sh"], 3600, ok_codes=(0, 1))

# what changed
design = J(DJ); sizes = J(W + "/sizes.json", {}); xc = J(W + "/extra_checks.json", {}).get("checks", {}); au = J(W + "/model_audit.json", {})
resized = {k: (snap["sizes"] or {}).get(k) and [(snap["sizes"] or {})[k], v] for k, v in sizes.items() if (snap["sizes"] or {}).get(k) != v}
summary = {"date": datetime.datetime.now().isoformat(timespec="seconds"), "run": runid,
           "steel_kg": [design0 and design0["steel_kg"]["total"], design["steel_kg"]["total"]],
           "members_resized": resized, "drift_mm": drift[-1] if drift else None,
           "checks": {k: v["status"] for k, v in xc.items()}, "checks_changed": {k: [((snap["extra_checks"] or {}).get("checks", {}).get(k) or {}).get("status"), v["status"]] for k, v in xc.items() if ((snap["extra_checks"] or {}).get("checks", {}).get(k) or {}).get("status") != v["status"]},
           "audit_findings": [f"[{f['severity']}] {f['area']}: {f['text']}" for f in au.get("findings", [])],
           "structural_walls": inf.strip().splitlines(), "redundancy": {"bare_frame_gravity_wind_over_capacity": over, "run": rb}, "steps": log}
json.dump(summary, open(W + "/update_summary.json", "w"), indent=1)
print(f"run {runid}; steel {summary['steel_kg'][0]} -> {summary['steel_kg'][1]} kg; {len(resized)} member(s) resized; drift {summary['drift_mm']}")
print("checks:", ", ".join(f"{k} {v}" for k, v in summary["checks"].items()))
for k, v in summary["checks_changed"].items(): print(f"  CHANGED {k}: {v[0]} -> {v[1]}")
print(f"redundancy: bare frame under gravity and wind, {over} member(s) over capacity" + (" (OK)" if over == 0 else " - NOT REDUNDANT"))
for x in summary["structural_walls"]: print("walls:", x)
for x in summary["audit_findings"]: print("audit:", x[:180])
