#!/usr/bin/env bash
# Robot run -> member check -> resize, until nothing changes (or N rounds). docs/ROBOT_RC_FRAME_PROCESS.md
#   bash scripts/structure/iterate.sh <work dir> <robot runs dir> [rounds=6]
# Start from minimum sizes with: echo '{}' > <work dir>/sizes.json. Long: run it in the background.
here="$(cd "$(dirname "$0")" && pwd)"; W="$1"; O="$2"; N="${3:-6}"
# one loop per work folder at a time (28 Oct: a stopped loop kept running and overwrote sizes.json)
lock="$W/.iterate.lock"; if [ -e "$lock" ] && kill -0 "$(cat "$lock")" 2>/dev/null; then echo "another loop is running (pid $(cat "$lock"))"; exit 1; fi
echo $$ > "$lock"; trap 'rm -f "$lock"' EXIT
for i in $(seq 1 "$N"); do
  out=$(timeout 900 node "$here/robot-run.mjs" "$W" "$O" "${SOLVER:-local}" 2>&1)
  run=$(echo "$out" | grep -o '"run":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "== round $i: $run $(echo "$out" | grep -o '"error":"[^"]*"' | head -1)"
  [ -z "$run" ] && { echo "$out" | tail -5; exit 1; }
  python -I "$here/member-check.py" "$W" "$O" "$run" | grep -E "over capacity|max util|changes|drift|DRIFT"
  echo "$run" > "$W/last_run.txt"
  c=$(python -I -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$W/resize.json")
  [ "$c" = "0" ] && { echo "converged: $run"; exit 0; }
done
echo "not converged after $N rounds"
