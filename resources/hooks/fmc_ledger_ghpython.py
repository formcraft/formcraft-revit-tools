# Formcraft ledger hook for a Grasshopper GhPython (or Rhino 8 Python 3) component. docs/AUTOMATION_BALANCE.md
# Records one solve in %APPDATA%\Formcraft\ledger\external-YYYY-MM.jsonl: kind, script, ok, ms. No names.
# Paste into the component. Grasshopper re-solves often: the hook records a run only when the component's input `run`
# is True (a button), so a slider drag doesn't fill the ledger. It never fails the component.

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


import time
if run:  # noqa: F821 (the component's boolean input)
    _fmc_t0, _fmc_ok = time.time(), False
    try:
        # ... the component's own work; it sets a ...
        a = None
        _fmc_ok = True
    finally:
        fmc_ledger("grasshopper", ghenv.Component.NickName, _fmc_ok, (time.time() - _fmc_t0) * 1000)  # noqa: F821
