# Look at a generated page before it is published: wraps it in the same skeleton the artifact host adds (charset,
# viewport, [hidden] rule, a "no capabilities" claude stub), renders it in headless Edge with software WebGL, and saves a
# screenshot. Also reports text that should never show on a page (stray backslashes, template placeholders, "undefined").
#   python -I scripts/tools/preview.py <page.html> <out.png> [width=1400] [height=1000] [js to run after load]
import sys, os, re, subprocess, tempfile, pathlib
page, png = sys.argv[1], sys.argv[2]
w, h = (sys.argv[3] if len(sys.argv) > 3 else "1400"), (sys.argv[4] if len(sys.argv) > 4 else "1000")
after = sys.argv[5] if len(sys.argv) > 5 else ""
body = open(page, encoding="utf-8").read()
text = re.sub(r"<script.*?</script>|<style.*?</style>", "", body, flags=re.S)
bad = [m for m in re.findall(r".{0,30}(?:\\[nt\"'/]|__[A-Z0-9]+__|\bundefined\b|\bNaN\b).{0,30}", re.sub(r"<[^>]+>", " ", text))]
html = ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<style>[hidden]{display:none!important}</style></head><body>'
        '<script>window.claude={use:async()=>null}</script>' + body +
        (f"<script>setTimeout(()=>{{{after}}},1500)</script>" if after else "") + "</body></html>")
tmp = pathlib.Path(tempfile.gettempdir()) / ("preview_" + os.path.basename(page))
tmp.write_text(html, encoding="utf-8")
edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
subprocess.run([edge, "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", f"--window-size={w},{h}",
                "--virtual-time-budget=20000", f"--screenshot={os.path.abspath(png)}", tmp.as_uri()], capture_output=True, timeout=180)
print(png, "written" if os.path.exists(png) else "NOT written")
print("text problems:", bad[:10] if bad else "none")
