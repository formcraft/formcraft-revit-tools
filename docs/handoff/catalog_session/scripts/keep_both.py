"""Resolve conflict blocks keeping both sides: the action z.enum lists are united; otherwise ours then theirs,
closing ours' open braces first (two branches each added an `if (args.action === ...) {` block at the same place)."""
import re, sys
pat = re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\r?\n(.*?)>>>>>>> [^\n]*\n", re.S)
ENUM = re.compile(r'^(\s*action: z\.enum\(\[)(.*?)(\]\),\s*)$', re.M)

def both(m):
    a, b = m.group(1), m.group(2)
    nl = "\r\n" if "\r\n" in a + b else "\n"
    ea, eb = ENUM.search(a), ENUM.search(b)
    if ea and eb:
        xs = re.findall(r'"[^"]+"', ea.group(2))
        xs += [x for x in re.findall(r'"[^"]+"', eb.group(2)) if x not in xs]
        a = a[:ea.start()] + ea.group(1) + ", ".join(xs) + ea.group(3) + a[ea.end():]
        b = b[:eb.start()] + b[eb.end():]
        b = re.sub(r"^\r?\n", "", b)
        return a + b
    opened = a.count("{") - a.count("}")
    close = "".join("    }" + nl for _ in range(max(0, opened)))
    # theirs then needs its own closing dropped by the same amount (the shared closer after the block)
    return a + close + b[:len(b)] if opened <= 0 else a + close + strip_close(b, opened, nl)

def strip_close(b, n, nl):
    return b  # the shared closing brace after the block closes theirs

for p in sys.argv[1:]:
    s = open(p, encoding="utf-8", newline="").read()
    s2 = pat.sub(both, s)
    open(p, "w", encoding="utf-8", newline="").write(s2)
    print(p, "left:", s2.count("<<<<<<<"))
