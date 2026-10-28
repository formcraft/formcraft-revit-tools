"""Standards Bank page: every document Formcraft needs, by discipline, marked Have / Get."""
import html, json, os
S = os.path.dirname(os.path.abspath(__file__))
C, T, R = "Core", "By building type", "Reference"
F, P = "Free", "Paid"
H = True
# (discipline, title, what it gives us, priority, cost, where, have)
D = [
 # Uganda law and approvals
 ("Uganda", "Building Control Act 2013", "Permits, inspections, who approves", C, F, "ulii.org", H),
 ("Uganda", "Building Control Regulations 2020", "Permit process, forms, timelines", C, F, "ulii.org", H),
 ("Uganda", "Building Control fee schedule (gazetted) / KCCA plan fees", "Permit fees per m2", C, F, "Gazette, KCCA, municipal councils", False),
 ("Uganda", "Physical Planning Act 2010", "Development permission", C, F, "ulii.org", H),
 ("Uganda", "Physical Planning (Amendment) Act 2020 and Physical Planning Regulations", "Current committees, fees, forms", C, F, "ulii.org, MoLHUD", False),
 ("Uganda", "Public Health Act Cap 281 and Public Health (Drainage and Sanitation) Rules", "Drainage and WC rules split from the building rules", C, F, "ulii.org", False),
 ("Uganda", "Condominium Property Act 2001 and Regulations", "Apartments: unit plans, common property, approvals", T, F, "ulii.org", False),
 ("Uganda", "Land Act, Registration of Titles Act, Survey Act", "Site title, boundaries, surveys", R, F, "ulii.org", False),
 ("Uganda", "Local Governments Act", "Which council approves what", R, F, "ulii.org", False),
 ("Uganda", "Roads Act / UNRA Act and Access to Roads Act", "Road reserves and access to plots", C, F, "ulii.org", False),
 ("Uganda", "Civil Aviation Authority obstacle rules (aerodrome regulations) and ICAO Annex 14", "Height limits near airports (Entebbe, Kajjansi)", T, F, "caa.go.ug", False),
 ("Uganda", "Historical Monuments Act", "Heritage sites and buildings", R, F, "ulii.org", False),
 ("Uganda", "Uganda Communications Commission mast guidelines", "Telecom masts on buildings", T, F, "ucc.co.ug", False),
 # Planning and site
 ("Planning and site", "National Physical Planning Standards and Guidelines 2011", "Coverage, setbacks, parking by zone", C, F, "MoLHUD", H),
 ("Planning and site", "Local physical development plans (Kira, Wakiso, KCCA KPDP, each project's district)", "Height limits, plot ratio, zoning on the actual site", C, F, "The municipal or district council", False),
 ("Planning and site", "National Physical Development Plan (final)", "National corridors and buffers", R, F, "MoLHUD", H),
 ("Planning and site", "MoWT Road Design Manual (geometric design)", "Access roads, junctions, parking geometry", T, F, "works.go.ug", False),
 ("Planning and site", "MoWT Drainage Design Manual", "Rainfall intensity curves, site drainage", C, F, "works.go.ug", False),
 # Building code and architecture
 ("Architecture and building code", "National Building Code 2019", "Rooms, stairs, light, ventilation, services", C, F, "ulii.org", H),
 ("Architecture and building code", "Public Health (Building) Rules", "Legacy rules where the 2019 code is silent", R, F, "ulii.org", H),
 ("Architecture and building code", "Neufert Architects' Data", "Space standards, furniture, circulation for every room type", C, P, "Bookshops", False),
 ("Architecture and building code", "Metric Handbook (planning and design data)", "Building-type planning data", C, P, "Bookshops", False),
 ("Architecture and building code", "BS 5395-1 stairs", "Stair geometry beyond the code", R, P, "BSI", False),
 ("Architecture and building code", "BS 6180 barriers and BS 6206 / EN 12600 safety glazing", "Guards, balustrades, glass in doors and low windows", C, P, "BSI", False),
 ("Architecture and building code", "BS EN 17037 daylight in buildings", "Daylight targets the 2019 code asks for (20-30%)", C, P, "BSI", False),
 # Accessibility
 ("Accessibility", "Building Control (Accessibility Standards) Code 2019", "Ramps, toilets, doors, signage", C, F, "ulii.org", H),
 ("Accessibility", "ISO 21542 / BS 8300-1 and -2", "Detail the Uganda code leaves to figures", R, P, "ISO, BSI", False),
 # Fire
 ("Fire safety", "BS 9999 (all buildings) and BS 9991 (dwellings)", "Escape widths, travel distances, compartments", C, P, "BSI", False),
 ("Fire safety", "BS 5839-1 and -6 fire alarms", "Alarm systems (empty in the Uganda codes)", C, P, "BSI", False),
 ("Fire safety", "BS 5266-1 emergency lighting and ISO 7010 safety signs", "Escape lighting and signs", C, P, "BSI, ISO", False),
 ("Fire safety", "BS EN 12845 sprinklers / NFPA 13", "Sprinkler design for large buildings", T, P, "BSI, NFPA (free to read online)", False),
 ("Fire safety", "NFPA 101 Life Safety Code", "Alternative escape rules many clients ask for", R, P, "nfpa.org (free to read online)", False),
 # Structural
 ("Structural", "Uganda Structural Design Code 2019", "The statutory structural code", C, F, "ulii.org", H),
 ("Structural", "US 319 seismic code", "Seismic zones and base shear", C, P, "UNBS", H),
 ("Structural", "EN 1990 basis of design", "Load combinations and factors", C, P, "BSI, UNBS, law.resource.org", False),
 ("Structural", "EN 1991-1-1 densities and imposed loads", "Loads", C, P, "law.resource.org", H),
 ("Structural", "EN 1991-1-4 wind", "Wind on roofs, gables, walls", C, P, "law.resource.org", False),
 ("Structural", "EN 1991-1-2 fire actions, 1-6 execution, 1-7 accidental", "Fire loads, temporary works, impact", R, P, "law.resource.org", False),
 ("Structural", "EN 1992-1-1 concrete", "Concrete design", C, P, "law.resource.org", H),
 ("Structural", "EN 1992-1-2 concrete fire", "Fire ratings of members", C, P, "law.resource.org", H),
 ("Structural", "EN 1993-1-1, 1-3, 1-8 steel", "Roof trusses, cold-formed purlins, connections", C, P, "law.resource.org", False),
 ("Structural", "EN 1994-1-1 composite", "Steel-concrete floors", R, P, "law.resource.org", False),
 ("Structural", "EN 1995-1-1 timber", "Timber roofs and floors", C, P, "law.resource.org", False),
 ("Structural", "EN 1996-1-1, 1-2, 2 masonry", "Stone, block and brick walls", C, P, "law.resource.org", False),
 ("Structural", "EN 1997-1 and -2 geotechnical", "Foundations and site investigation", C, P, "law.resource.org", False),
 ("Structural", "EN 1998-1 and -5 seismic", "Ductile detailing, seismic foundations", C, P, "law.resource.org", False),
 ("Structural", "Economic Concrete Frame Elements to EC2", "Economic member sizes", C, F, "concretecentre.com", H),
 ("Structural", "How to Design Concrete Structures using EC2 + Worked Examples to EC2", "Shear, punching, laps, worked through", C, F, "concretecentre.com", False),
 ("Structural", "IStructE Manual for concrete building structures to EC2 (2006)", "Whole design process", C, P, "IStructE", False),
 ("Structural", "IStructE Standard Method of Detailing Structural Concrete", "Detailing and drawings", C, P, "IStructE", H),
 ("Structural", "BS 8666 scheduling of reinforcement (full)", "Bar schedules", C, P, "BSI", False),
 ("Structural", "Steel Designer's Manual / Blue Book section tables", "Steel section properties", R, P, "SCI", False),
 ("Structural", "BS 8002 retaining walls and BS 8004 foundations", "Retaining walls on sloping Kampala sites", C, P, "BSI", False),
 ("Structural", "IStructE Design recommendations for multi-storey and underground car parks", "Car park structures", T, P, "IStructE", False),
 # Geotechnical
 ("Geotechnical", "BS 5930 site investigation", "What to ask a soils lab for", C, P, "BSI", False),
 ("Geotechnical", "Geological map of Uganda / Kampala sheets", "Expected ground before investigation", R, F, "Directorate of Geological Survey and Mines", False),
 # Materials
 ("Materials (UNBS)", "UNBS product standards: cement, steel bars, concrete blocks, burnt clay bricks, iron sheets, timber, tiles, paints, glass", "What can be specified and bought in Uganda", C, P, "UNBS catalogue", False),
 ("Materials (UNBS)", "UNBS standards: PVC/HDPE pipes, electrical cables and accessories, LPG cylinders", "MEP products", C, P, "UNBS catalogue", False),
 ("Materials (UNBS)", "EN 206 / BS 8500 concrete specification", "Concrete mixes and exposure", C, P, "BSI", False),
 ("Materials (UNBS)", "EN 13670 execution of concrete", "Site workmanship and tolerances", C, P, "BSI", False),
 # Electrical
 ("Electrical and lighting", "Electrical Installations Code 2019", "Statutory wiring rules", C, F, "ulii.org", H),
 ("Electrical and lighting", "Electricity Act 1999 + Amendment 2022", "Licences and connections", C, F, "ulii.org", H),
 ("Electrical and lighting", "Electricity (Installation Permits) and (Safety Code) Regulations 2003", "Wiring permits, clearances to lines", C, F, "era.go.ug", False),
 ("Electrical and lighting", "BS 7671 IET Wiring Regulations", "Circuits, cable ratings, bathroom zones", C, P, "IET", False),
 ("Electrical and lighting", "EN 12464-1 lighting of work places / SLL Code for Lighting", "Lux levels per room", C, P, "BSI, CIBSE", False),
 ("Electrical and lighting", "BS EN 62305 lightning protection", "Lightning systems (high-risk in Uganda)", C, P, "BSI", False),
 ("Electrical and lighting", "TIA-568 / EN 50173 structured cabling", "Data and ICT rooms", T, P, "TIA, BSI", False),
 ("Electrical and lighting", "Solar PV: IEC 62548 and UNBS PV standards", "Rooftop solar", T, P, "IEC, UNBS", False),
 # Mechanical
 ("Mechanical, HVAC and lifts", "Mechanical Installations Code 2019", "Statutory plumbing, drainage, fire, lifts", C, F, "ulii.org", H),
 ("Mechanical, HVAC and lifts", "CIBSE Guide A environmental design", "Ventilation rates, comfort, climate data", C, P, "CIBSE", False),
 ("Mechanical, HVAC and lifts", "CIBSE Guide B HVAC and Guide G public health", "System design", C, P, "CIBSE", False),
 ("Mechanical, HVAC and lifts", "ASHRAE 62.1, 55, 90.1", "Ventilation, comfort, energy (US-led clients)", R, P, "ASHRAE (free to read online)", False),
 ("Mechanical, HVAC and lifts", "BS EN 81-20, -50, -70 lifts", "Lift shafts, pits, accessible lifts", T, P, "BSI", False),
 ("Mechanical, HVAC and lifts", "BS EN 378 refrigeration and heat pumps", "Split units and chillers", T, P, "BSI", False),
 # Plumbing
 ("Plumbing, drainage and water", "Water Act Cap 152 + Water Resources and Waste Discharge Regulations", "Connections, boreholes, discharge permits", C, F, "ulii.org", False),
 ("Plumbing, drainage and water", "Ministry of Water and Environment Water Supply Design Manual", "Demand, tanks, septic tanks, soakaways", C, F, "mwe.go.ug", False),
 ("Plumbing, drainage and water", "BS 6465-1, -2, -3 sanitary installations", "Toilet counts for every building type", C, P, "BSI", False),
 ("Plumbing, drainage and water", "EN 806 water supply and EN 12056 gravity drainage", "Pipe sizing", C, P, "BSI", False),
 ("Plumbing, drainage and water", "EN 752 drains outside buildings", "Site drainage", C, P, "BSI", False),
 ("Plumbing, drainage and water", "EN 12566 small wastewater treatment / BS 6297", "Septic tanks and drainage fields", C, P, "BSI", False),
 ("Plumbing, drainage and water", "BS 8515 rainwater harvesting and BS 8525 greywater", "Harvesting and reuse (NBC asks for both)", C, P, "BSI", False),
 ("Plumbing, drainage and water", "BS 6891 gas and BS 5482 LPG / UNBS LPG installation", "Gas (empty in the Uganda codes)", T, P, "BSI, UNBS", False),
 # Environment and sustainability
 ("Environment and sustainability", "National Environment Act 2019", "ESIA triggers", C, F, "ulii.org", H),
 ("Environment and sustainability", "Wetlands, River Banks and Lake Shores Regulations", "Buffer distances", C, F, "ulii.org, nema.go.ug", False),
 ("Environment and sustainability", "Environmental and Social Assessment Regulations 2020", "ESIA process and fees", C, F, "nema.go.ug", False),
 ("Environment and sustainability", "Noise Standards and Control Regulations", "Noise limits", C, F, "nema.go.ug", False),
 ("Environment and sustainability", "Waste Management Regulations 2020", "Waste storage and construction waste", C, F, "nema.go.ug", H),
 ("Environment and sustainability", "Uganda energy efficiency law and appliance standards (latest)", "Energy rules for buildings", C, F, "ulii.org, MEMD", False),
 ("Environment and sustainability", "EDGE user guide", "The green rating used in East Africa", C, F, "edgebuildings.com", False),
 ("Environment and sustainability", "LEED v4 BD+C", "Green rating (international clients)", R, F, "usgbc.org", H),
 ("Environment and sustainability", "BREEAM In-Use International", "Green rating for existing buildings", R, F, "bregroup.com", H),
 ("Environment and sustainability", "WELL Building Standard", "Health and wellbeing rating", R, F, "wellcertified.com", False),
 ("Environment and sustainability", "ISO 7730 thermal comfort", "Comfort in hot climates", R, P, "ISO", False),
 # Acoustics
 ("Acoustics", "BS 8233 sound insulation and noise in buildings", "Room noise levels", C, P, "BSI", False),
 ("Acoustics", "ISO 717 and ISO 3382", "Rating walls and floors; room acoustics", R, P, "ISO", False),
 # Building types
 ("Building types", "MoH health facility infrastructure guidelines and standard plans", "Clinics, health centres, hospitals", T, F, "health.go.ug", False),
 ("Building types", "UK HTMs and HBNs (health)", "Detailed hospital design", T, F, "gov.uk", False),
 ("Building types", "MoES Basic Requirements and Minimum Standards for education institutions", "Schools: classrooms, ratios, facilities", T, F, "education.go.ug", False),
 ("Building types", "UK Building Bulletins (BB93 acoustics, BB103 areas)", "School design detail", T, F, "gov.uk", False),
 ("Building types", "EAC criteria for classification of hotels and restaurants / UTB standards", "Hotels and lodges", T, F, "UTB, EAC", False),
 ("Building types", "Sport England design guidance", "Sports halls and pitches", T, F, "sportengland.org", False),
 # BIM and documentation
 ("BIM and documentation", "ISO 19650-1, -2, -3, -5", "Information management, naming, security", C, P, "ISO, BSI (UK versions free)", False),
 ("BIM and documentation", "Uniclass 2015 tables", "Classification codes for elements, spaces, products", C, F, "thenbs.com", False),
 ("BIM and documentation", "ISO 13567-1, -2 CAD layers", "Layer naming", C, P, "ISO", H),
 ("BIM and documentation", "ISO 13567-3 (full)", "Layer examples (we have a preview)", R, P, "ISO", False),
 ("BIM and documentation", "ISO 128 / ISO 7519 technical drawings", "Drawing conventions", C, P, "ISO", False),
 ("BIM and documentation", "ISO 16739 IFC and buildingSMART IDS", "Model exchange and checking", R, F, "buildingsmart.org", False),
 ("BIM and documentation", "BS 8541 BIM objects", "Family (object) standards", R, P, "BSI", False),
 # Specification and construction
 ("Specification and construction", "MoWT Standard Specifications for Building Works 2013", "Specification template", C, F, "works.go.ug", H),
 ("Specification and construction", "BS 8000 workmanship series", "Workmanship on site by trade", C, P, "BSI", False),
 ("Specification and construction", "BS 5534 slating and tiling, BS 6229 flat roofs, BS 8217 felt roofs", "Roof specification", C, P, "BSI", False),
 ("Specification and construction", "BS 8102 waterproofing below ground", "Basements and ground slabs", C, P, "BSI", False),
 ("Specification and construction", "BS 5385 tiling, BS 8204 screeds, BS EN 13914 render and plaster", "Finishes", C, P, "BSI", False),
 ("Specification and construction", "BS 8417 timber preservation", "Termite and rot treatment", C, P, "BSI", False),
 ("Specification and construction", "Concrete Society TR34 ground floors", "Ground slabs", T, P, "concrete.org.uk", False),
 # Cost and contracts
 ("Cost, measurement and contracts", "RICS NRM1, NRM2, NRM3", "Estimating, BOQ measurement, maintenance costs", C, P, "rics.org", False),
 ("Cost, measurement and contracts", "A recent priced Ugandan BOQ and supplier price lists", "Unit rates in UGX", C, F, "Your projects", False),
 ("Cost, measurement and contracts", "AECOM Africa property and construction cost guide", "Cost per m2 benchmarks for Kampala", C, F, "aecom.com", False),
 ("Cost, measurement and contracts", "FIDIC Red, Yellow and White Books", "Construction and consultancy contracts", C, P, "fidic.org", False),
 ("Cost, measurement and contracts", "PPDA Act 2003, PPDA Regulations 2024, standard bidding documents", "Public projects", C, F, "ppda.go.ug", False),
 # Site safety
 ("Site safety", "Occupational Safety and Health Act 2006", "Workplace and site duties", C, F, "ulii.org", H),
 ("Site safety", "Factories (Building Operations) Rules", "Scaffolds, excavations, edges", C, F, "ulii.org", H),
 ("Site safety", "ISO 45001 and UK CDM 2015 guidance", "Designer's safety duties (reference)", R, P, "ISO; gov.uk free", False),
 # Practice and business
 ("Practice and business", "Architects Registration Act and the Board's scale of fees", "Professional fees and duties", C, F, "ulii.org, ARB Uganda", False),
 ("Practice and business", "Engineers Registration Act and Surveyors Registration Act", "Who may sign what", C, F, "ulii.org", False),
 ("Practice and business", "Taxation Handbook 2025/26 and Tax Amendments 2026/27", "Current VAT, WHT, PAYE", C, F, "ura.go.ug", H),
 ("Practice and business", "NSSF Act 2022 and Local Service Tax", "Payroll duties", C, F, "ulii.org, nssfug.org", False),
 ("Practice and business", "Companies, Employment, Workers' Compensation Acts", "Running the firm", R, F, "ulii.org", H),
]
exec(open(os.path.join(S, "bank_ea.py"), encoding="utf-8").read()); D += EA
exec(open(os.path.join(S, "bank_world.py"), encoding="utf-8").read()); D += WORLD
exec(open(os.path.join(S, "bank_products.py"), encoding="utf-8").read()); D += PRODUCTS
exec(open(os.path.join(S, "bank_vdc.py"), encoding="utf-8").read()); D += VDC
# PPDA regulations 2024 arrived: mark have
D = [d if not d[1].startswith("PPDA Act 2003, PPDA Regulations 2024") else ("Cost, measurement and contracts", "Uganda PPDA Regulations (current) and threshold schedule in UGX", "Public procurement methods and thresholds (the 2024 file in the folder is South Sudan's)", C, F, "ppda.go.ug", False) for d in D]
exec(open(os.path.join(S, "bank_ug_done.py"), encoding="utf-8").read()); D = mark(D)
have = sum(1 for d in D if d[6]); total = len(D); core_get = sum(1 for d in D if d[3] == C and not d[6]); free_get = sum(1 for d in D if not d[6] and d[4] == F)
disc = []
for d in D:
    if d[0] not in disc: disc.append(d[0])
def row(i, d):
    st = "have" if d[6] else "get"
    return f'''<tr class="r {st}" data-p="{html.escape(d[3])}" data-c="{html.escape(d[4])}"><td class="ck"><input type="checkbox" id="c{i}" {"checked disabled" if d[6] else ""} aria-label="Got it"></td>
<td><div class="t">{html.escape(d[1])}</div><div class="w">{html.escape(d[2])}</div></td><td><span class="pr pr-{d[3].split()[0].lower()}">{html.escape(d[3])}</span></td><td class="src"><span class="cost cost-{d[4].lower()}">{d[4]}</span> {html.escape(d[5])}</td><td class="st">{"In the bank" if d[6] else ""}</td></tr>'''
secs, i = [], 0
# VDC, BIM and CAD sources with checked links (manifest_international_vdc.json, fmc-fetch-standards.mjs downloads the free PDFs)
LIB = os.environ.get("FMC_STD_LIBRARY", r"D:\Fomcraft\FMC_BIM_27\FMC_Standards_Library")
TITLE = {"manifest_international_vdc.json": "VDC, BIM and CAD", "manifest_kenya.json": "Kenya", "manifest_tanzania.json": "Tanzania", "manifest_international_free.json": "Free international references"}
for MF in [os.path.join(LIB, f) for f in TITLE if os.path.exists(os.path.join(LIB, f))]:   # every hunted manifest gets its own register
    M = json.load(open(MF, encoding="utf-8")); folder = os.path.join(LIB, M.get("region", "International"), M.get("country", "VDC-BIM-CAD")); NAME = TITLE[os.path.basename(MF)]
    got = {f.split("__")[0] for f in (os.listdir(folder) if os.path.isdir(folder) else [])}
    ACC = {"free_pdf": ("Free PDF", "free"), "free_read": ("Read online", "free"), "free_register": ("Free, register", "free"), "paid": ("Paid", "paid")}
    GRP = {"bim-information": "Information management", "bim-openbim": "Open BIM", "bim-model": "Model and information need", "cad-drawing": "CAD and drawings",
           "classification": "Classification", "quality": "Quality", "project-risk": "Project and risk", "safety-environment": "Safety and environment", "software": "Revit, Robot, Navisworks"}
    ACC["request"] = ("From the office", "paid")
    for d in {x.get("discipline", "") for x in M.get("items", [])}: GRP.setdefault(d, d.replace("-", " ").capitalize())
    def mrow(x):
        a = ACC.get(x.get("access"), (x.get("access") or x.get("kind", ""), "paid")); have = x["id"] in got
        link = f'<a href="{html.escape(x["url"])}">{"download" if x.get("kind") == "pdf" else "open"}</a>' if x.get("url") else "not found"
        return (f'<tr class="r {"have" if have else "get"}" data-p="Core" data-c="{"Free" if a[1] == "free" else "Paid"}"><td class="ck"></td><td><div class="t">{html.escape(x["title"])}</div><div class="w">{html.escape(x.get("notes", ""))}</div></td>'
                f'<td class="src">{html.escape(GRP.get(x.get("discipline"), x.get("discipline", "")))}<br>{html.escape(str(x.get("edition", "")))}</td><td class="src"><span class="cost cost-{a[1]}">{a[0]}</span> {link}{" ✓" if x.get("verified") else ""}</td>'
                f'<td class="st">{"In the library" if have else ""}</td></tr>')
    items = M.get("items", [])
    body = "".join(mrow(x) for x in sorted(items, key=lambda x: (x.get("discipline", ""), x["title"])))
    nfree = sum(1 for x in items if x.get("kind") == "pdf"); nhave = sum(1 for x in items if x["id"] in got)
    secs.append(f'<section><h2>{html.escape(NAME)}: where to get each <span class="gc">{nhave} of {len(items)} in the library · {nfree} free PDFs download automatically · ✓ link checked</span></h2>'
                f'<div class="tw"><table><thead><tr><th></th><th>Document</th><th>Group, edition</th><th>Access</th><th></th></tr></thead><tbody>{body}</tbody></table></div></section>')
for name in disc:
    rows = [d for d in D if d[0] == name]
    body = "".join(row(i + j, d) for j, d in enumerate(rows)); i += len(rows)
    h = sum(1 for d in rows if d[6])
    secs.append(f'<section><h2>{html.escape(name)} <span class="gc">{h} of {len(rows)} in the bank</span></h2><div class="tw"><table><thead><tr><th></th><th>Document</th><th>Priority</th><th>Where</th><th></th></tr></thead><tbody>{body}</tbody></table></div></section>')
page = f'''<title>Standards Bank Plan</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400&display=swap">
<style>
/* layout: one register column; summary and filters on top, then one table per discipline */
:root {{ --bg:#f6f7f9; --panel:#fff; --fg:#1b2330; --muted:#5d6878; --line:#d9dee6; --accent:#2c5a8c; --ok:#1f7a4d; --core:#b4432f; --type:#9a6a00; --ref:#6b7585;
  --body:"Public Sans",system-ui,sans-serif; --mono:"JetBrains Mono",ui-monospace,monospace }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --bg:#11161d; --panel:#18202a; --fg:#e4e9f0; --muted:#98a3b3; --line:#2a3542; --accent:#7fb0e6; --ok:#5cc28f; --core:#ef8a74; --type:#e0b34d; --ref:#8d97a6; color-scheme:dark }} }}
:root[data-theme="dark"] {{ --bg:#11161d; --panel:#18202a; --fg:#e4e9f0; --muted:#98a3b3; --line:#2a3542; --accent:#7fb0e6; --ok:#5cc28f; --core:#ef8a74; --type:#e0b34d; --ref:#8d97a6; color-scheme:dark }}
body {{ background:var(--bg); color:var(--fg); font-family:var(--body); font-size:15px; line-height:1.5 }}
.wrap {{ max-width:1040px; margin:0 auto; padding-block:28px 64px; padding-left:max(16px, env(safe-area-inset-left,0px)); padding-right:max(16px, env(safe-area-inset-right,0px)); display:grid; gap:26px }}
h1 {{ margin:0; font-size:28px; text-wrap:balance }} header p {{ margin:4px 0 0; color:var(--muted); max-width:70ch }}
.stats {{ display:flex; flex-wrap:wrap; gap:10px 28px; margin-top:14px; font-variant-numeric:tabular-nums }} .stats b {{ display:block; font-size:22px }} .stats span {{ font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em }}
.filters {{ display:flex; flex-wrap:wrap; gap:8px; margin-top:16px }}
.filters button {{ font:inherit; font-size:13px; padding:4px 12px; border-radius:16px; border:1px solid var(--line); background:var(--panel); color:var(--fg); cursor:pointer }}
.filters button[aria-pressed="true"] {{ border-color:var(--accent); color:var(--accent); font-weight:600 }} .filters button:focus-visible {{ outline:2px solid var(--accent) }}
h2 {{ font-size:17px; margin:0 0 8px; display:flex; gap:10px; align-items:baseline; flex-wrap:wrap }} .gc {{ font-weight:400; font-size:13px; color:var(--muted) }}
.tw {{ overflow-x:auto; border:1px solid var(--line); border-radius:8px; background:var(--panel) }}
table {{ border-collapse:collapse; width:100%; font-size:14px; min-width:640px }} th, td {{ text-align:left; vertical-align:top; padding:8px 10px; border-bottom:1px solid var(--line) }} tr:last-child td {{ border-bottom:0 }}
th {{ font-size:12px; color:var(--muted); font-weight:600 }} .t {{ font-weight:600 }} .w {{ color:var(--muted); font-size:13px }}
.ck {{ width:28px }} .src {{ font-size:13px; color:var(--muted); min-width:160px }} .st {{ font-size:12px; color:var(--ok); white-space:nowrap }}
.pr {{ font-size:11px; text-transform:uppercase; letter-spacing:.05em; white-space:nowrap }} .pr-core {{ color:var(--core) }} .pr-by {{ color:var(--type) }} .pr-reference {{ color:var(--ref) }}
.cost {{ font-size:11px; text-transform:uppercase; letter-spacing:.05em; border:1px solid currentColor; border-radius:9px; padding:0 6px }} .cost-free {{ color:var(--ok) }} .cost-paid {{ color:var(--muted) }}
tr.have .t {{ color:var(--muted) }} tr.got .t {{ text-decoration:line-through; color:var(--muted) }}
</style>
<div class="wrap"><header><h1>Standards Bank Plan</h1>
<p>Every standard Formcraft needs across all disciplines. Core documents apply to most projects; building-type ones only when that type is designed; reference ones help but aren't required. Each country's own laws and codes come first; international standards fill what they leave out. The general disciplines (fire, structural, services, BIM) apply in every country. North America, Europe and Asia each have their own set at the end. Tick what you've downloaded; Claude marks it "in the bank" once it's read into the kit. Progress 28 Oct 2026: Uganda done and the hand-download list mostly in (about 205 documents read; 2,333 rules in the kit), including the CAA advisory circulars, KCCA fees and permit systems, ERA permits and tariffs, MoWT road and drainage manuals, MWE water supply and source protection, KCCA onsite sanitation, the ARB handbook and the Kampala topographic and Uganda geology maps. Still missing: Electricity (Safety Code) Regulations 2003 and 2016 amendment, the ARB fee bye-laws 2009 tables, KCCA per-zone 2040 values. Next: Kenya and Tanzania, the rest of East Africa, West Africa, then the world. Added 28 Oct 2026: 64 VDC, CAD and BIM standards (information management, data and classification, drawing production, Revit, Robot and Navisworks guidance, quality systems, construction testing, commissioning and handover); editions marked "confirm" come from a research note and must be checked when each document is collected. Added later 28 Oct 2026: the "VDC, BIM and CAD: where to get each" register at the top, 81 sources with checked links and current editions (the UK BIM Framework is now the IMI Framework; OmniClass is no longer free; ISO 9001, 14001 and 19011 have 2026 editions); its 19 free PDFs are already in the library, the 26 read-online sources need a browser (the USACE CAD standards are free but their links expire), and the 36 paid ones (mostly ISO) are to buy.</p>
<div class="stats"><div><b>{have} / {total}</b><span>in the bank</span></div><div><b>{core_get}</b><span>core still to get</span></div><div><b>{free_get}</b><span>free to download</span></div></div>
<div class="filters" role="group" aria-label="Filter"><button data-f="all" aria-pressed="true">All</button><button data-f="get" aria-pressed="false">Still to get</button><button data-f="core" aria-pressed="false">Core to get</button><button data-f="free" aria-pressed="false">Free to get</button></div></header>
{"".join(secs)}</div>
<script>
const KEY = "fmc-bank-ticks";
let ticks = {{}}; try {{ ticks = JSON.parse(localStorage.getItem(KEY) || "{{}}"); }} catch (e) {{}}
document.querySelectorAll("tr.get input").forEach((c) => {{ c.checked = !!ticks[c.id]; c.closest("tr").classList.toggle("got", c.checked);
  c.addEventListener("change", () => {{ ticks[c.id] = c.checked; c.closest("tr").classList.toggle("got", c.checked); try {{ localStorage.setItem(KEY, JSON.stringify(ticks)); }} catch (e) {{}} }}); }});
const btns = document.querySelectorAll(".filters button");
btns.forEach((b) => b.addEventListener("click", () => {{ btns.forEach((x) => x.setAttribute("aria-pressed", x === b)); const f = b.dataset.f;
  document.querySelectorAll("tr.r").forEach((r) => {{ const get = r.classList.contains("get");
    r.hidden = f === "get" ? !get : f === "core" ? !(get && r.dataset.p === "Core") : f === "free" ? !(get && r.dataset.c === "Free") : false; }});
  document.querySelectorAll("section").forEach((s) => {{ s.hidden = !s.querySelector("tr.r:not([hidden])"); }}); }}));
</script>'''
import sys
OUTP = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get("FMC_STD_LIBRARY", r"D:\Fomcraft\FMC_BIM_27\FMC_Standards_Library"), "standards_bank.html")
open(OUTP, "w", encoding="utf-8").write(page); print(OUTP)
print(f"{total} documents, {have} in the bank, {core_get} core to get, {free_get} free to get, {len(disc)} disciplines")
