# A discipline's review pack for the professional who stamps it (architect, services engineer, fire engineer...), built
# from its package (packages.py) with the shared review page (structure/review_page.py): scope, design status, every
# quantity and rate, the discipline's own schedules, and its 3D model where exported. The structure has its own richer
# pack (structure/review_pack.py). Marks and sign-off live in the published artifact's database.
#   python -I scripts/project/review_disc.py <report dir> <discipline> <out html> [config json]
import json, os, sys, datetime, html
RD, D, OUT = sys.argv[1:4]; CF = sys.argv[4] if len(sys.argv) > 4 else RD + "/report.json"
J = lambda p, d=None: json.load(open(p, encoding="utf-8")) if os.path.exists(p) else d
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "structure")); import review_page
cfg = J(CF, {}); p = J(f"{RD}/packages/{D}.json"); e = html.escape
SIGN = {"architecture": ("Architect", "Architects Registration Board (ARB) number", "I have reviewed this architectural design; the sections marked accepted meet the brief, the building regulations and the planning conditions, and the corrections noted are to be made before submission."),
        "plumbing": ("Plumbing and drainage engineer", "Engineers Registration Board (ERB) number", "I have reviewed this plumbing and drainage design; the sections marked accepted are correct to the codes stated."),
        "electrical": ("Electrical engineer", "ERB number / ERA licence", "I have reviewed this electrical design; the sections marked accepted are correct to the codes stated."),
        "mechanical": ("Mechanical engineer", "ERB number", "I have reviewed this mechanical design; the sections marked accepted are correct to the codes stated."),
        "fire": ("Fire engineer", "Registration number", "I have reviewed this fire and life safety design; the sections marked accepted are correct to the codes stated."),
        "interiors": ("Interior designer", "Registration number", "I have reviewed this interior design and its schedules."),
        "external": ("Civil engineer", "ERB number", "I have reviewed the external works and boundary design."),
        "landscape": ("Landscape architect", "Registration number", "I have reviewed this landscape design.")}
signer, reglabel, statement = SIGN.get(D, ("Professional", "Registration number", "I have reviewed this design."))
S = []
def sec(i, title, intro, cols, rows, eqs=()): S.append({"id": i, "title": title, "intro": intro, "eqs": list(eqs), "cols": cols, "rows": [[str(r[0])] + [c if isinstance(c, (int, float, bool)) or c is None else str(c) for c in r[1:]] for r in rows]})
SC = {"designed": "Designed", "partial": "Partly", "allowance": "Allowance only", "not": "Not covered"}
sec("scope", "Scope and status", p.get("summary", ""), ["Part of the project", "Status", "What it covers"], [[k, k, SC.get(v[0], v[0]), v[1]] for k, v in p.get("scope", {}).items()])
sec("checks", "Design status", "What is done and what is still open in this discipline.", ["Item", "Status"], [[i, t, {"done": "Done", "partial": "Partly done", "not": "Open"}[c]] for i, (t, c) in enumerate(p.get("checks", []))])
# the checks this professional verifies (review_checklists.json): done where the design reports them, else awaiting design
CL = J(os.path.join(os.path.dirname(os.path.abspath(__file__)), "review_checklists.json"), {}).get(D, {})
done = {t.lower(): c for t, c in p.get("checks", [])}
designed = p.get("status") == "designed"
for ti, (topic, rows) in enumerate(CL.items()):
    st = lambda t: {"done": "Checked in the design", "partial": "Partly checked"}.get(done.get(t.lower()), "To verify against the model" if designed else "Awaiting design")
    sec(f"cl{ti}", topic, "The checks the professional verifies here, with the standard each one comes from and how it is worked out." + ("" if designed else " This discipline is not designed yet: the checks are listed now so the scope is agreed, and they fill in as the design is done."),
        ["Check", "Basis", "Method", "Status"], [[f"cl{ti}.{i}", c, b, m, st(c)] for i, (c, b, m) in enumerate(rows)])
if p.get("key"): sec("key", "Key figures", "Measured from the model.", ["Figure", "Value"], [[i, l, v] for i, (v, l) in enumerate(p["key"])])
q = p.get("quantities", [])
sec("quantities", "Quantities and rates", "Every quantity is measured from the model (or an allowance where not designed yet); rates from the Formcraft price book, split into materials, labour and plant.",
    ["Item", "Group", "Quantity", "Unit", "Materials rate", "Full rate", "Likely total UGX"],
    [[i, x["item"], x.get("group", ""), x["qty"], x["unit"], round(x.get("rate_mat", x["rate"])[1]), round(x["rate"][1]), round(x["qty"] * x["rate"][1])] for i, x in enumerate(q)], ["total = quantity × full rate (likely)"])
if D == "architecture" and p.get("rooms"):
    sec("rooms", "Room schedule", "Every room in the model with its level and area.", ["Room", "Level", "Area m²"], [[f"r{i}", r[0].title(), r[1], r[2]] for i, r in enumerate(p["rooms"])])
    inf = J(os.path.join(os.path.dirname(RD), "_Structure", "_work", "infill.json"), [])
    if inf:
        sec("infill", "Structural walls (walls the structure relies on)", "The earthquake design counts on these masonry walls as structure (US 319, K = 2). They must be built tight to the columns and beams, tied into the columns every 450 mm, and never removed, cut or given bigger openings without the structural engineer. Click a row to see the wall in the model.",
            ["Between columns", "Level z mm", "Length mm", "Thickness mm", "Openings %", "Counted as structure"],
            [[str(x["walls"][0]) if x["walls"] else f"w{i}", f'{x["cols"][0]} – {x["cols"][1]}', x["z"][0], x["length_mm"], x["thickness_mm"], x["openings_pct"], x["structural"]] for i, x in enumerate(inf)])
if p.get("drawings"): sec("drawings", "Drawings", "The sheets in this set.", ["Sheet"], [[i, os.path.basename(x)] for i, x in enumerate(p["drawings"])])
if p.get("notes"): sec("notes", "Notes and assumptions", "Recorded with the design.", ["Note"], [[i, n] for i, n in enumerate(p["notes"] if isinstance(p["notes"], list) else [p["notes"]])])
mesh = None; mf = os.path.join(RD, (p.get("model") or {}).get("mesh", "") or "-")
if not os.path.exists(mf):   # not modelled yet: the building itself, for context (fittings already placed show under their parts)
    mf = os.path.join(RD, ((J(f"{RD}/packages/architecture.json", {}) or {}).get("model") or {}).get("mesh", "") or "-")
if os.path.exists(mf):
    mesh = J(mf) | {"colors": {"Walls": "#e9e6df", "Boundary walls": "#d8d4cb", "Floors": "#d5d3cc", "Roofs": "#c8573a", "Doors": "#8a6b4c", "Windows": "#2f3a44", "Stairs": "#cfcac0",
                               "Structural Columns": "#b9bdc0", "Structural Framing": "#b9bdc0", "Planting": "#5f8f43", "Toposolid": "#b7c49a", "Furniture": "#e0a15c", "Casework": "#e0a15c"},
                    "labels": {}}
    # part names as in the project report (parts_template.json): every category under the part that draws it
    tpl = J(os.path.join(os.path.dirname(os.path.abspath(__file__)), "parts_template.json"), {})
    for dd, L in tpl.items():
        if dd.startswith("_"): continue
        for prt in L:
            for c in prt["cats"]:
                if c == "*" and dd == D: mesh["labels"]["*"] = prt["name"]
                elif c not in ("*", "#lines"): mesh["labels"].setdefault(c, prt["name"])
today = datetime.date.today().strftime("%d %B %Y")
links = cfg.get("links", {})
meta = {"title": f"Ogala {p['label'].split(' (')[0]} Review", "eyebrow": f"{cfg.get('firm', 'Formcraft')} · {cfg.get('project', 'The Ogala Residence')} · {p['label']} · For review by the {signer.lower()}",
        "h1": f"{p['label'].split(' (')[0]} review pack", "intro": f"Prepared by {cfg.get('presenter', 'Emlyn Atochon')}, {cfg.get('firm', 'Formcraft')}, {today}. Each section sets out what was designed and measured.",
        "back": f'<a href="{e(links.get("project", ""))}">Back to the project report</a>' if links.get("project") else "",
        "signer": signer, "statement": statement, "reglabel": reglabel,
        "gaps": [t for t, c in p.get("checks", []) if c != "done"]}
page = review_page.render(S, meta, mesh)
open(OUT, "w", encoding="utf-8").write(page)
print(OUT, f"{len(page) / 1e6:.2f} MB", len(S), "sections", sum(len(s["rows"]) for s in S), "rows", "with 3D" if mesh else "no 3D")
