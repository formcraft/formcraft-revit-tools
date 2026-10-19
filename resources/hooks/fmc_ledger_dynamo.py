# Formcraft ledger hook for a Dynamo Python Script node (CPython3 / PythonNet3, or IronPython2). docs/AUTOMATION_BALANCE.md
# Records one run of the graph in %APPDATA%\Formcraft\ledger\external-YYYY-MM.jsonl: kind, script, ok, ms. No names.
# Paste into the graph's main Python node: the function first, the wrapper around the node's work. It never fails the
# node: any problem writing the line is ignored. The ledger stays on this PC.

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
_fmc_t0, _fmc_ok = time.time(), False
try:
    # ... the node's own work; it sets OUT ...
    OUT = None
    _fmc_ok = True
finally:
    fmc_ledger("dynamo", "FMC_ModelHealth", _fmc_ok, (time.time() - _fmc_t0) * 1000)
