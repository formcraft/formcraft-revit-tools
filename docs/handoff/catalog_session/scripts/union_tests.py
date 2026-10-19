"""Resolve a package.json conflict on the "test" line: union both sides' test files, ours first."""
import re, sys
p = sys.argv[1]
s = open(p, encoding="utf-8", newline="").read()
pat = re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\r?\n(.*?)>>>>>>> [^\n]*\n", re.S)
def res(m):
    a, b = m.group(1), m.group(2)
    if '"test"' not in a or '"test"' not in b:
        raise SystemExit("non-test conflict")
    ta = re.findall(r"\S+\.test\.js", a)
    tb = re.findall(r"\S+\.test\.js", b)
    out = list(ta) + [t for t in tb if t not in ta]
    line = a.splitlines(keepends=True)[0]
    start = line[: line.index(ta[0])]
    end = line[line.index(ta[-1]) + len(ta[-1]):]
    return start + " ".join(out) + end
s2 = pat.sub(res, s)
open(p, "w", encoding="utf-8", newline="").write(s2)
print("ok", "<<<<<<<" in s2)
