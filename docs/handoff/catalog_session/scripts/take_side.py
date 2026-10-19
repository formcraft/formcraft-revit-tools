"""Resolve every conflict block in the given files by keeping one side: ours (default) or theirs."""
import re, sys
side = "ours"
files = sys.argv[1:]
if files and files[0] in ("--ours", "--theirs"):
    side = files[0][2:]; files = files[1:]
pat = re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\r?\n(.*?)>>>>>>> [^\n]*\n", re.S)
for p in files:
    s = open(p, encoding="utf-8", newline="").read()
    s2 = pat.sub(lambda m: m.group(1) if side == "ours" else m.group(2), s)
    open(p, "w", encoding="utf-8", newline="").write(s2)
    print(p, "left:", s2.count("<<<<<<<"))
