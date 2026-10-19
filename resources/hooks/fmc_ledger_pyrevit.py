# Formcraft ledger hook for a pyRevit button (IronPython 2.7 or CPython 3). docs/AUTOMATION_BALANCE.md
# Records one run in %APPDATA%\Formcraft\ledger\external-YYYY-MM.jsonl: kind, script, ok, ms. Nothing else, no names.
# Paste the function at the top of script.py, then wrap the button's work as shown at the bottom. It never fails the
# button: any problem writing the line is ignored. The ledger stays on this PC.

def fmc_ledger(kind, script, ok, ms, project=""):
    try:
        import os, io, json, time
        d = os.environ.get("FMC_LEDGER_DIR") or os.path.join(os.environ["APPDATA"], "Formcraft", "ledger")
        if not os.path.isdir(d):
            os.makedirs(d)
        now = time.gmtime()
        line = json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", now), "kind": kind, "script": script, "ok": bool(ok),
                           "ms": int(ms), "project": project, "started_by": os.environ.get("FMC_STARTED_BY") or "person"})
        with io.open(os.path.join(d, "external-%s.jsonl" % time.strftime("%Y-%m", now)), "a", encoding="utf-8") as f:
            f.write(u"%s\n" % line)
    except Exception:
        pass


# --- the button's work, wrapped (replace main() with the script's own code) -----------------------------------------
import time
_fmc_t0, _fmc_ok = time.time(), False
try:
    # main()
    _fmc_ok = True
finally:
    try:
        _fmc_project = __revit__.ActiveUIDocument.Document.Title.split("-")[0].split("_")[0]  # noqa: F821 (pyRevit's global)
    except Exception:
        _fmc_project = ""
    fmc_ledger("pyrevit", "FMC_CreateSheetsFromRegister", _fmc_ok, (time.time() - _fmc_t0) * 1000, _fmc_project)
