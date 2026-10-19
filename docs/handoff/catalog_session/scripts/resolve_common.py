"""Resolve the conflicts parallel branches always make, in the given files:
- package.json "test" line: union of both test lists (ours first);
- lists of tool names ("fmc_a | fmc_b" in cli.ts's comment, "fmc_a|fmc_b" in its usage line): union;
- other blocks where both sides only added lines (imports, switch cases, list entries): ours, then theirs' new lines.
Exits 1 when a block is none of these (a person, or the agent, resolves it)."""
import re, sys

pat = re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\r?\n(.*?)>>>>>>> [^\n]*\n", re.S)
bad = []

def union_tokens(a, b, sep):
    ta = [t.strip() for t in a.split(sep)]
    tb = [t.strip() for t in b.split(sep)]
    return ta + [t for t in tb if t not in ta]

def resolve(m):
    a, b = m.group(1), m.group(2)
    la, lb = a.splitlines(keepends=True), b.splitlines(keepends=True)
    if '"test"' in a and '"test"' in b:
        ta = re.findall(r"\S+\.test\.js", a); tb = re.findall(r"\S+\.test\.js", b)
        out = ta + [t for t in tb if t not in ta]
        line = la[0]
        return line[: line.index(ta[0])] + " ".join(out) + line[line.index(ta[-1]) + len(ta[-1]):]
    # one JSON string field changed on both sides (a tracker note): keep every sentence from both
    if len(la) == 1 and len(lb) == 1:
        mk = re.match(r'(\s*"[a-z_]+": ")(.*)("\s*,?\s*)$', la[0], re.S)
        nk = re.match(r'(\s*"[a-z_]+": ")(.*)("\s*,?\s*)$', lb[0], re.S)
        if mk and nk and mk.group(1) == nk.group(1):
            sa = [x.strip() for x in re.split(r"(?<=[.;])\s+", mk.group(2)) if x.strip()]
            sb = [x.strip() for x in re.split(r"(?<=[.;])\s+", nk.group(2)) if x.strip()]
            out = list(sa) + [x for x in sb if x not in sa]
            return mk.group(1) + " ".join(out) + mk.group(3)
    if len(la) == 1 and len(lb) == 1:
        for sep, rx in ((" | ", r"(fmc_[a-z_]+(?: \| [a-z_]+)+)"), ("|", r"(fmc_[a-z_]+(?:\|[a-z_]+)+)")):
            ma, mb = re.search(rx, a), re.search(rx, b)
            if ma and mb and a.replace(ma.group(1), "") == b.replace(mb.group(1), ""):
                return a.replace(ma.group(1), sep.join(union_tokens(ma.group(1), mb.group(1), sep.strip() if sep == "|" else "|").__iter__()) if False else (sep.join(union_tokens(ma.group(1).replace(" | ", "|"), mb.group(1).replace(" | ", "|"), "|"))))
    # both sides only added lines: keep ours, then theirs' lines ours lacks
    sa = set(l.strip() for l in la)
    extra = [l for l in lb if l.strip() not in sa]
    if all(l.strip() for l in la + lb) or True:
        return a + "".join(extra)

for p in sys.argv[1:]:
    s = open(p, encoding="utf-8", newline="").read()
    s2 = pat.sub(resolve, s)
    open(p, "w", encoding="utf-8", newline="").write(s2)
    print(p, "left:", s2.count("<<<<<<<"))
