#!/bin/sh
# Merge each PR (squash) once its checks pass; stop at a failure or conflict.
# "No checks" counts as green only for a PR that touches nothing but docs/ (CI skips those); otherwise it waits for
# the checks to appear (right after a push they aren't registered yet).
for pr in "$@"; do
  docs_only=$(gh pr view "$pr" --json files --jq '[.files[].path | startswith("docs/")] | all')
  for i in $(seq 1 150); do
    state=$(gh pr view "$pr" --json state,mergeable --jq '.state+" "+.mergeable')
    case "$state" in MERGED*) echo "#$pr already merged"; continue 2;; *CONFLICTING*) echo "#$pr CONFLICTING"; exit 1;; esac
    checks=$(gh pr checks "$pr" 2>&1)
    if echo "$checks" | grep -qiE "no checks reported"; then
      if [ "$docs_only" = "true" ] && [ "$i" -ge 3 ]; then break; fi
      sleep 60; continue
    fi
    if echo "$checks" | grep -qE "	fail	"; then echo "#$pr checks FAILED"; echo "$checks"; exit 1; fi
    if ! echo "$checks" | grep -qE "	(pending|queued|in_progress)	"; then break; fi
    sleep 60
  done
  if gh pr merge "$pr" --squash --delete-branch=false 2>&1; then echo "#$pr MERGED"; else echo "#$pr merge failed"; exit 1; fi
  sleep 20
done
