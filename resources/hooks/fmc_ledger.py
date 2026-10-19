"""Formcraft ledger hook for a plain Python script (3.x). docs/AUTOMATION_BALANCE.md

Records one run in %APPDATA%\\Formcraft\\ledger\\external-YYYY-MM.jsonl: kind, script, ok, ms. No names, no data.
Copy this file beside the script (or paste the function) and wrap the work:

    from fmc_ledger import fmc_run
    with fmc_run("python", "fmc_boq_build"):
        main()

It never fails the script: any problem writing the line is ignored. The ledger stays on this PC.
"""
import contextlib
import datetime
import json
import os
import time


def fmc_ledger(kind, script, ok, ms, project=""):
    try:
        d = os.environ.get("FMC_LEDGER_DIR") or os.path.join(os.environ["APPDATA"], "Formcraft", "ledger")
        os.makedirs(d, exist_ok=True)
        now = datetime.datetime.now(datetime.timezone.utc)
        line = json.dumps({"at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "kind": kind, "script": script, "ok": bool(ok),
                           "ms": int(ms), "project": project, "started_by": os.environ.get("FMC_STARTED_BY") or "person"})
        with open(os.path.join(d, "external-%s.jsonl" % now.strftime("%Y-%m")), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


@contextlib.contextmanager
def fmc_run(kind, script, project=""):
    """Times the block and records it: ok unless it raised (the error still goes up)."""
    t0, ok = time.time(), False
    try:
        yield
        ok = True
    finally:
        fmc_ledger(kind, script, ok, (time.time() - t0) * 1000, project)


if __name__ == "__main__":
    # python fmc_ledger.py <kind> <script> [ok|error] [ms]: record a run from any shell
    import sys
    a = sys.argv[1:] + ["", "", "ok", "0"][len(sys.argv[1:]):]
    fmc_ledger(a[0] or "other", a[1] or "(unnamed)", a[2] != "error", float(a[3] or 0))
