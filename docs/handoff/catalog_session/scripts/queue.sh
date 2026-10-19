#!/bin/sh
# One merge queue: for each PR in order, bring it up to date with main (resolving the usual test-list, tool-list and
# add-only conflicts), run the server tests, push, wait for its checks, merge. Stops at the first thing it can't settle.
S="C:/Users/USER/AppData/Local/Temp/claude/d--Fomcraft-FMC-BIM-27-FMC-PLUGINS-FMC-REVIT-TOOLS/e0b17a38-1beb-4501-9340-fc53942749d5/scratchpad"
REPO="D:/Fomcraft/FMC_BIM_27/FMC_PLUGINS/FMC_REVIT_TOOLS/formcraft-revit-tools"
for pr in "$@"; do
  cd "$REPO" || exit 1
  state=$(gh pr view "$pr" --json state --jq .state)
  [ "$state" = "MERGED" ] && { echo "#$pr already merged"; continue; }
  br=$(gh pr view "$pr" --json headRefName --jq .headRefName)
  git fetch -q origin
  dir=$(git worktree list --porcelain | awk -v b="refs/heads/$br" '/^worktree /{w=substr($0,10)} $0=="branch "b{print w}')
  if [ -z "$dir" ]; then
    dir="D:/fq/$pr"; rm -rf "$dir"; git worktree prune
    git worktree add -q "$dir" "$br" 2>/dev/null || git worktree add -q -B "$br" "$dir" "origin/$br" || { echo "#$pr: no worktree for $br"; exit 1; }
  fi
  cd "$dir" || exit 1
  git pull -q --no-rebase origin "$br" 2>/dev/null
  if ! git merge -q origin/main --no-edit >/dev/null 2>&1; then
    files=$(git diff --name-only --diff-filter=U)
    python "$S/resolve_common.py" $files >/dev/null
    if grep -l "^<<<<<<< " $files >/dev/null 2>&1; then echo "#$pr: conflicts left in $files"; exit 1; fi
    for j in $(echo "$files" | grep '\.json$'); do python -c "import json,sys;json.load(open(sys.argv[1],encoding='utf-8-sig'))" "$j" || { echo "#$pr: $j isn't valid JSON after the merge"; exit 1; }; done
    git add $files && git commit -q --no-edit || { echo "#$pr: commit failed"; exit 1; }
  fi
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/$br)" ]; then
    ( cd server && { [ -d node_modules ] || npm ci --silent >/dev/null 2>&1; } && npm run build >/dev/null 2>&1 && npm test 2>&1 | grep -q "^ℹ fail 0" ) || { echo "#$pr: server build or tests fail after merging main"; exit 1; }
    git push -q origin "HEAD:$br" || { echo "#$pr: push failed"; exit 1; }
    echo "#$pr: up to date with main, tests pass, pushed"
    sleep 90
  fi
  sh "$S/merge_when_green.sh" "$pr" || exit 1
done
echo "queue done"
