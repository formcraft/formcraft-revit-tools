"""Builds the Formcraft Build Tracker's data from the repo and GitHub, so the dashboard stays current.

Sources (the repo is the record; nothing here is typed by hand at refresh time):
  docs/tracker/features.json   every feature and its state (update it in the PR that changes a state)
  docs/tracker/kit.json        kit counts (update it with each kit release)
  docs/tracker/decisions.json  what waits on the owner or an engineer
  docs/tracker/events.json     kit releases and canvas designs (not in git history)
  docs/tracker/mep_matrix.json the engineering grid, 23 systems x 7 capabilities (E0); counts are computed, never stored
  git log origin/main          merged pull requests
  GitHub issues (test-finding) test findings and their state
  GitHub open pull requests     what is in review and whether its checks passed

Usage: python scripts/tracker/refresh.py <out_dir>
Writes features.json, kit.json, decisions.json, timeline.json, findings.json, prs.json, mep_matrix.json and manifest.json (a hash per file, so a
scheduled refresh uploads only what changed).
"""
import hashlib, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REPO = "formcraft/formcraft-revit-tools"


def load(name):
    with open(os.path.join(ROOT, "docs", "tracker", name), encoding="utf-8") as f:
        return json.load(f)


def mep_matrix():
    """The engineering grid with its counts by state, so the dashboard and the Master Board never hard-code them."""
    m = load("mep_matrix.json")
    by_state = {s: 0 for s in m["states"]}
    for c in m["cells"]:
        by_state[c["state"]] += 1
    applicable = len(m["cells"]) - by_state.get("Not applicable", 0)
    m["summary"] = dict(cells=len(m["cells"]), applicable=applicable, tested=by_state.get("Tested in Revit", 0), by_state=by_state)
    return m


def git_timeline():
    subprocess.run(["git", "-C", ROOT, "fetch", "-q", "origin", "main"], check=False)
    out = subprocess.run(["git", "-C", ROOT, "log", "origin/main", "--format=%aI|%s"], capture_output=True, text=True, check=True).stdout
    rows = []
    for line in out.splitlines():
        at, msg = line.split("|", 1)
        m = re.search(r"\(#(\d+)\)\s*$", msg)
        title = re.sub(r"\s*\(#\d+\)\s*$", "", msg)
        low = title.lower()
        kind = ("Fix" if low.startswith("fix") or re.match(r"f-\d", low) else
                "Plan" if low.startswith(("plan", "ideas", "full ideas", "add docs")) else
                "CI" if low.startswith("ci") else
                "Test" if low.startswith("test feedback") else "Feature")
        rows.append(dict(at=at, pr=int(m.group(1)) if m else None, title=title, kind=kind))
    return rows


def findings():
    out = subprocess.run(["gh", "api", "--paginate", f"repos/{REPO}/issues?state=all&labels=test-finding&per_page=100"],
                         capture_output=True, text=True, check=True).stdout
    issues = json.loads(out.replace("][", ","))
    rows = []
    for i in issues:
        labels = {l["name"] for l in i["labels"]}
        fid, _, text = i["title"].partition(": ")
        state = ("Closed" if i["state"] == "closed" else "Fixed, retest due" if "fixed-retest" in labels
                 else "Needs you" if "needs-user" in labels else "Open")
        rows.append(dict(finding=fid, issue=i["number"], title=text, state=state, raised=i["created_at"][:10],
                         closed=(i.get("closed_at") or "")[:10]))
    return sorted(rows, key=lambda r: r["finding"], reverse=True)


def open_prs():
    out = subprocess.run(["gh", "api", f"repos/{REPO}/pulls?state=open&per_page=50"], capture_output=True, text=True, check=True).stdout
    rows = []
    for p in json.loads(out):
        runs = json.loads(subprocess.run(["gh", "api", f"repos/{REPO}/commits/{p['head']['sha']}/check-runs"],
                                         capture_output=True, text=True, check=True).stdout).get("check_runs", [])
        concl = [r.get("conclusion") for r in runs if r["name"] != "Stage main for the updater"]
        checks = ("Failed" if any(c in ("failure", "cancelled", "timed_out") for c in concl)
                  else "Passed" if concl and all(c in ("success", "skipped", "neutral") for c in concl)
                  else "Waiting for the pilot PC")
        rows.append(dict(pr=p["number"], title=p["title"], branch=p["head"]["ref"], opened=p["created_at"][:16].replace("T", " "),
                         checks=checks))
    return rows


def main(out):
    os.makedirs(out, exist_ok=True)
    data = {
        "features": load("features.json"),
        "kit": load("kit.json"),
        "decisions": load("decisions.json"),
        "mep_matrix": mep_matrix(),
        "timeline": sorted(git_timeline() + [dict(e, pr=e.get("pr")) for e in load("events.json")], key=lambda r: r["at"]),
        "findings": findings(),
        "prs": open_prs(),
    }
    manifest = {}
    for name, rows in data.items():
        text = json.dumps(rows, indent=1, ensure_ascii=False)
        with open(os.path.join(out, name + ".json"), "w", encoding="utf-8") as f:
            f.write(text)
        manifest[name] = {"rows": len(rows), "sha256": hashlib.sha256(text.encode()).hexdigest()}
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print(json.dumps(manifest))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tracker_out")
