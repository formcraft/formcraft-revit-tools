# A project release for the client portal (owner 28 Oct: "after the design is done, create a link that uploads it to the
# website database"): the current reports and their data, numbered, with a manifest the website reads and a plain list of
# what changed since the last release (for the client's email). The website side receives it; this side only builds and,
# when configured, sends.
#   python -I scripts/project/release.py <project 01_WIP> [--note "what this release is for"] [--send]
# Output: <01_WIP>/_Release/R<nn>/ {manifest.json, changes.md, docs/*.html, data/*.json} and _Release/index.json.
# --send: POSTs manifest + files to FMC_RELEASE_ENDPOINT with FMC_RELEASE_TOKEN (environment only, never in the repo);
#         without them the release is built and kept, and nothing leaves the machine.
import json, os, sys, shutil, hashlib, datetime, glob, urllib.request
WIP = sys.argv[1]; NOTE = sys.argv[sys.argv.index("--note") + 1] if "--note" in sys.argv else ""; SEND = "--send" in sys.argv
J = lambda p, d=None: json.load(open(p, encoding="utf-8")) if os.path.exists(p) else d
REP, ST = os.path.join(WIP, "_Report"), os.path.join(WIP, "_Structure")
cfg = J(REP + "/report.json", {}); links = cfg.get("links", {}); scfg = J(ST + "/_work/config.json", {})
code = cfg.get("code", "OGL"); REL = os.path.join(WIP, "_Release"); os.makedirs(REL, exist_ok=True)
index = J(REL + "/index.json", {"project": cfg.get("project"), "releases": []})
n = len(index["releases"]) + 1; out = os.path.join(REL, f"R{n:02d}"); os.makedirs(out + "/docs", exist_ok=True); os.makedirs(out + "/data", exist_ok=True)
latest = lambda pat: (sorted(glob.glob(pat)) or [None])[-1]
sha = lambda f: hashlib.sha256(open(f, "rb").read()).hexdigest()
docs = []
def doc(key, title, disc, kind, audience, src, url=None):
    if not src or not os.path.exists(src): return
    dst = os.path.join(out, "docs" if src.endswith(".html") else "data", f"{code}-FMC-{key}{os.path.splitext(src)[1]}"); shutil.copy(src, dst)
    docs.append({"key": key, "title": title, "discipline": disc, "kind": kind, "audience": audience, "file": os.path.relpath(dst, out).replace("\\", "/"),
                 "sha256": sha(dst), "bytes": os.path.getsize(dst), "url": url})
# what the client sees, what the professionals check, and the data behind them
doc("RPT-PROJECT", "Project report", "project", "client_report", "client", latest(REP + "/*_project_report.html"), links.get("project"))
doc("RPT-STRUCTURE", "Structural design report", "structure", "design_report", "client", latest(ST + "/*_structural_design_report_visual.html"), links.get("structure", {}).get("report"))
doc("REV-STRUCTURE", "Structural review pack", "structure", "review_pack", "professional", latest(ST + "/*_engineer_review.html"), links.get("structure", {}).get("review"))
for d in ("architecture", "plumbing", "electrical", "mechanical", "interiors", "fire", "external", "landscape"):
    doc(f"REV-{d.upper()}", f"{d.title()} review pack", d, "review_pack", "professional", REP + f"/review_{d}.html", links.get(d, {}).get("review"))
for p in sorted(glob.glob(REP + "/packages/*.json")): doc(f"DAT-PKG-{os.path.basename(p)[:-5].upper()}", "Discipline package", os.path.basename(p)[:-5], "data", "internal", p)
for k, f in (("DAT-CHECKS", "extra_checks.json"), ("DAT-AUDIT", "model_audit.json"), ("DAT-WALLS", "infill.json"), ("DAT-UPDATE", "update_summary.json")):
    doc(k, f, "structure", "data", "internal", os.path.join(ST, "_work", f))
doc("DAT-BBS", "Bar bending schedules", "structure", "data", "professional", latest(ST + "/*_BBS_preliminary.xlsx"))
# summary figures the portal shows without opening a report
pk = {os.path.basename(p)[:-5]: J(p) for p in glob.glob(REP + "/packages/*.json")}
cost = {d: round(sum(q["qty"] * q["rate"][1] for q in p["quantities"])) for d, p in pk.items()}
status = {d: {"status": p.get("status"), "checks_done": sum(1 for _, c in p.get("checks", []) if c == "done"), "checks": len(p.get("checks", []))} for d, p in pk.items()}
upd = J(ST + "/_work/update_summary.json", {})
summary = {"cost_full_likely_ugx": cost, "total_full_likely_ugx": sum(cost.values()), "disciplines": status,
           "structure": {"steel_kg": (upd.get("steel_kg") or [None, None])[1], "drift_mm": upd.get("drift_mm"), "checks": upd.get("checks"), "redundant": (upd.get("redundancy") or {}).get("bare_frame_gravity_wind_over_capacity") == 0}}
# what changed since the last release
prev = J(os.path.join(REL, index["releases"][-1]["folder"], "manifest.json")) if index["releases"] else None
ch = []
if prev:
    pd = {x["key"]: x for x in prev["documents"]}
    for x in docs:
        if x["key"] not in pd: ch.append(f"New: {x['title']}")
        elif pd[x["key"]]["sha256"] != x["sha256"] and x["audience"] != "internal": ch.append(f"Updated: {x['title']}")
    pc, nc = prev["summary"]["cost_full_likely_ugx"], cost
    for d in sorted(set(pc) | set(nc)):
        a, b = pc.get(d, 0), nc.get(d, 0)
        if abs(b - a) >= 1e6: ch.append(f"{d.title()} cost: UGX {a / 1e6:,.0f}M → {b / 1e6:,.0f}M")
    for d, s in status.items():
        o = prev["summary"]["disciplines"].get(d, {})
        if o.get("status") != s["status"]: ch.append(f"{d.title()}: {o.get('status', 'new')} → {s['status']}")
        elif o.get("checks_done") != s["checks_done"]: ch.append(f"{d.title()}: {s['checks_done']} of {s['checks']} design checks done (was {o.get('checks_done')})")
else:
    ch.append("First release: the project report, the structural design and every discipline's review pack.")
manifest = {"schema": "formcraft.release/1", "project": cfg.get("project"), "code": code, "release": n, "label": f"R{n:02d}", "date": datetime.datetime.now().isoformat(timespec="seconds"),
            "prepared_by": f"{cfg.get('presenter', '')}, {cfg.get('firm', '')}", "status": "preliminary", "note": NOTE, "changes": ch, "summary": summary, "documents": docs}
json.dump(manifest, open(out + "/manifest.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
open(out + "/changes.md", "w", encoding="utf-8").write(f"# {cfg.get('project')}: release R{n:02d}\n\n{NOTE}\n\n" + "\n".join(f"- {c}" for c in ch) + "\n")
index["releases"].append({"release": n, "folder": f"R{n:02d}", "date": manifest["date"], "note": NOTE, "changes": len(ch), "sent": False}); json.dump(index, open(REL + "/index.json", "w"), indent=1)
print(f"{out}: {len(docs)} documents ({sum(1 for d in docs if d['audience'] == 'client')} for the client, {sum(1 for d in docs if d['audience'] == 'professional')} for professionals), {len(ch)} change(s)")
for c in ch: print("  -", c)
if SEND:
    ep, tok = os.environ.get("FMC_RELEASE_ENDPOINT"), os.environ.get("FMC_RELEASE_TOKEN")
    if not ep or not tok: print("not sent: FMC_RELEASE_ENDPOINT / FMC_RELEASE_TOKEN not set (the website side provides them)"); sys.exit(0)
    req = urllib.request.Request(ep, data=json.dumps(manifest).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + tok}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r: print("sent manifest:", r.status)
    index["releases"][-1]["sent"] = True; json.dump(index, open(REL + "/index.json", "w"), indent=1)
