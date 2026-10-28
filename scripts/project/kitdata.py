# Kit data the report scripts read: the kit's 03_Master_Data copy is the source (one place for every project); the
# repo copy beside these scripts is only a fallback when the kit is not on this machine.
#   FMC_KIT (environment) overrides the kit folder.
import os, json
KIT = os.environ.get("FMC_KIT", r"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2")
FILES = {"parts": ("FMC_Report_Parts.json", "parts_template.json"), "checklists": ("FMC_Review_Checklists.json", "review_checklists.json")}
def path(name):
    kit, repo = FILES[name]
    p = os.path.join(KIT, "03_Master_Data", kit)
    return p if os.path.exists(p) else os.path.join(os.path.dirname(os.path.abspath(__file__)), repo)
def load(name):
    return json.load(open(path(name), encoding="utf-8"))
