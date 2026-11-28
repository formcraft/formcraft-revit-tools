import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, extractLinks, findInText, htmlToText, robotsAllows, titleOf } from "./webread.js";

const page = `<html><head><title>Kira Municipality &amp; plans</title><style>.x{}</style><script>var a=1</script></head>
<body><nav><a href="/home">Home</a></nav><h1>Physical Development Plan</h1><p>Plot coverage 40&nbsp;% in <b>medium</b> density.</p>
<ul><li>Front 6 m</li><li>Side 2 m</li></ul><table><tr><td>Zone</td><td>Height</td></tr></table>
<a href="docs/KPDP%202012.pdf">KPDP 2012 (PDF)</a> <a href="https://bim.maker.com/door.rfa">Door family</a> <a href="mailto:x@y.ug">mail</a>
<a href="docs/KPDP%202012.pdf#p3">again</a> <a href='/about'>About</a></body></html>`;

test("web reader (owner 27 Oct): pages as text, links typed for standards and family catalogues", () => {
  assert.equal(titleOf(page), "Kira Municipality & plans");
  const t = htmlToText(page);
  assert.ok(t.includes("# Physical Development Plan"));
  assert.ok(t.includes("Plot coverage 40 % in medium density."));
  assert.ok(t.includes("- Front 6 m") && t.includes("- Side 2 m"));
  assert.ok(!t.includes("var a") && !t.includes(".x{}") && !t.includes("Home"), "scripts, styles and menus are dropped");
  const ls = extractLinks(page, "https://kira.go.ug/plans/index.html");
  assert.deepEqual(ls.map((l) => l.kind), ["page", "pdf", "rfa", "page"], "menu links kept (they lead to more pages); mailto dropped; the #p3 duplicate merged");
  assert.equal(ls[1].url, "https://kira.go.ug/plans/docs/KPDP%202012.pdf");
  assert.equal(ls[2].same_site, false);
  assert.equal(decodeEntities("&#215; &#x00B2; &sup3; &unknown;"), "× ² ³ &unknown;");
  assert.equal(findInText(t, "coverage MEDIUM").length, 1);
});

test("robots.txt is obeyed: our own group first, else *, longest rule wins", () => {
  const r = "User-agent: *\nDisallow: /private/\nAllow: /private/open/\n\nUser-agent: BadBot\nDisallow: /";
  assert.equal(robotsAllows(r, "/laws/act.html"), true);
  assert.equal(robotsAllows(r, "/private/x"), false);
  assert.equal(robotsAllows(r, "/private/open/a.pdf"), true);
  assert.equal(robotsAllows("User-agent: formcraft\nDisallow: /\n\nUser-agent: *\nDisallow:", "/a"), false);
  assert.equal(robotsAllows("", "/anything"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /*.pdf$", "/a/b.pdf"), false);
});
