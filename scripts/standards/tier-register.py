# The kit's standards register (03_Master_Data/FMC_Standards_Sources.json) in the owner's hierarchy (28 Oct):
#   1 law (Uganda acts, regulations, statutory codes) > 2 national standard (UNBS / US) > 3 contract or client
#   > 4 international (ISO, IEC, EN, buildingSMART) > 5 industry (BS, ACI, NFPA, ASHRAE, CIBSE, IStructE, NIBS...)
#   > 6 company (Formcraft) > 7 project; plus "reference" for guidance and other countries' documents.
# Adds per source: tier, tier_rank, mandatory (law and national standards, and whatever a project adopts), and
# review_due (one year on: editions change). A tier set by hand ("tier_set_by": "owner") is never overwritten.
#   python -I scripts/standards/tier-register.py <kit folder> [--apply]   (dry run without --apply; .bak kept)
import json, os, sys, re, shutil, datetime, collections
KIT = sys.argv[1]; APPLY = "--apply" in sys.argv
F = os.path.join(KIT, "03_Master_Data", "FMC_Standards_Sources.json")
D = json.load(open(F, encoding="utf-8-sig")); S = D["sources"]
RANK = {"law": 1, "national_standard": 2, "contract": 3, "international": 4, "industry": 5, "company": 6, "project": 7, "reference": 8}
LAW = re.compile(r"\b(Act|Regulations?|Rules|Statutory Instrument|Ordinance|Bye-?laws?|Code, 20\d\d|Gazette|Order)\b", re.I)
def tier(s):
    i, t, j = s["id"].upper(), s.get("title", ""), (s.get("jurisdiction") or "")
    if i.startswith("MKT-") or j.lower().startswith(("none", "uganda (market", "uganda (practice")): return "reference"   # market data, commentary, lecture notes
    if i.startswith(("US-", "UNBS", "US_")) or "UNBS" in j or re.match(r"US \d", t): return "national_standard"
    ug = i.startswith("UG-") or j.startswith("Uganda")
    if ug and (LAW.search(t) or "statutory" in j.lower()): return "law"
    if ug: return "reference"   # Ugandan manuals, specifications, plans and guidance that are not law
    if i.startswith(("ISO", "IEC", "EN1", "EN-", "EN_", "BSI-EN", "IFC", "BSDD", "IDS", "BCF")) or re.match(r"(ISO|IEC|EN|Eurocode) ?\d?", t): return "international"
    if i.startswith(("BS", "ACI", "NFPA", "ASHRAE", "CIBSE", "ISTRUCTE", "ASTM", "SMACNA", "NIBS", "BIMFORUM", "CSI", "USACE", "NBS", "IET", "CC-", "LEED", "BREEAM")) or re.search(r"\b(BS \d|ACI \d|NFPA|ASHRAE|CIBSE|IStructE|ASTM)\b", t, re.I): return "industry"
    if i.startswith(("FMC", "FORMCRAFT")): return "company"
    return "reference"
due = (datetime.date.today() + datetime.timedelta(days=365)).isoformat(); n = collections.Counter(); kept = 0
for s in S:
    if s.get("tier_set_by") == "owner": kept += 1; n[s["tier"]] += 1; continue
    t = tier(s); s["tier"], s["tier_rank"] = t, RANK[t]; s["mandatory"] = t in ("law", "national_standard"); s.setdefault("review_due", due); n[t] += 1
D["hierarchy"] = {"order": sorted(RANK, key=RANK.get), "rule": "a higher tier governs; a project adopts lower-tier documents through its BEP and specification", "set": datetime.date.today().isoformat()}
print(dict(sorted(n.items(), key=lambda x: RANK[x[0]])), f"(kept {kept} set by hand)")
for t in ("national_standard", "international", "industry"):
    print(f"  {t}:", ", ".join(s["id"] for s in S if s["tier"] == t)[:300])
if APPLY:
    shutil.copy(F, F + ".bak-" + datetime.datetime.now().strftime("%Y%m%dT%H%M")); json.dump(D, open(F, "w", encoding="utf-8"), indent=1, ensure_ascii=False); print("written", F)
else: print("dry run: add --apply to write")
