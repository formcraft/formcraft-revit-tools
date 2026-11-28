# The shared review page every discipline's review pack is rendered with: numbered sections (method, formulas, tables),
# Accepted / Needs correction / Query per section, a tick or cross per row, notes, the professional's sign-off, and the
# interactive 3D model of what is being reviewed (rows and elements find each other by Revit id). Marks live in the
# artifact's shared database (collections "reviews" and "signoff"); the page reads without it.
import json, html
PAGE = r"""<title>__TITLE__</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* A calculation package for checking: numbered sections (method, formulas, the member table), each with a review strip;
   row ticks inside the tables; the sign-off at the end. Engineering-sheet look: white paper, ink, one blue for actions. */
:root { --paper:#f6f7f8; --panel:#ffffff; --ink:#15191d; --muted:#5a6570; --line:#d6dbe0; --acc:#1f5fbf; --ok:#0b8a3e; --fix:#c2362f; --q:#a86b00; --soft:#eef2f6;
  --sans:"IBM Plex Sans", "Segoe UI", Arial, sans-serif; --mono:"IBM Plex Mono", Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --paper:#101316; --panel:#171b1f; --ink:#e9edf0; --muted:#a3adb7; --line:#2b3238; --acc:#6aa1f0; --ok:#3cc172; --fix:#ef6b63; --q:#e0a63a; --soft:#1d2328; color-scheme:dark } }
:root[data-theme="dark"] { --paper:#101316; --panel:#171b1f; --ink:#e9edf0; --muted:#a3adb7; --line:#2b3238; --acc:#6aa1f0; --ok:#3cc172; --fix:#ef6b63; --q:#e0a63a; --soft:#1d2328; color-scheme:dark }
body { background:var(--paper); color:var(--ink); font:15px/1.55 var(--sans); }
.wrap { max-width:1100px; margin:0 auto; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); padding-block:28px 80px; display:grid; gap:22px; }
header { display:grid; gap:8px; border-bottom:3px solid var(--ink); padding-bottom:16px; }
.eyebrow { font:500 12px var(--mono); letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
h1 { font:700 clamp(26px, 4vw, 38px)/1.1 var(--sans); margin:0; text-wrap:balance; } h2 { font:700 19px/1.25 var(--sans); margin:0; } p { margin:0; max-width:75ch; }
.bar { position:sticky; top:env(safe-area-inset-top, 0px); z-index:5; background:var(--panel); border:1px solid var(--line); padding:10px 12px; display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; }
.prog { flex:1 1 220px; height:10px; display:flex; gap:2px; background:var(--soft); border-radius:2px; overflow:hidden; } .prog i { display:block; }
.bar b { font:600 13px var(--mono); } .bar select { font:13px var(--sans); padding:4px 6px; background:var(--panel); color:var(--ink); border:1px solid var(--line); border-radius:3px; }
.gaps { border-left:4px solid var(--q); background:var(--panel); padding:12px 14px; } .gaps ul { margin:6px 0 0; padding-left:18px; }
.toc { display:flex; flex-wrap:wrap; gap:6px; } .toc a { font:12px var(--mono); color:var(--ink); text-decoration:none; border:1px solid var(--line); padding:3px 7px; border-radius:3px; background:var(--panel); }
.toc a.ok { border-color:var(--ok); color:var(--ok); } .toc a.fix { border-color:var(--fix); color:var(--fix); } .toc a.q { border-color:var(--q); color:var(--q); }
section { background:var(--panel); border:1px solid var(--line); display:grid; gap:12px; padding:16px; min-width:0; scroll-margin-top:70px; }
section.ok { border-left:5px solid var(--ok); } section.fix { border-left:5px solid var(--fix); } section.q { border-left:5px solid var(--q); }
.sh { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; } .sh span { font:500 12px var(--mono); color:var(--muted); }
.eq { display:grid; gap:4px; background:var(--soft); padding:10px 12px; font:13px/1.5 var(--mono); overflow-x:auto; }
.tw { overflow-x:auto; max-height:460px; overflow-y:auto; border:1px solid var(--line); }
table { border-collapse:collapse; width:100%; font-size:13px; } th { position:sticky; top:0; background:var(--panel); text-align:left; font:500 11px var(--mono); text-transform:uppercase; letter-spacing:.05em; color:var(--muted); padding:7px 9px; border-bottom:1px solid var(--line); }
td { padding:6px 9px; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums; } td.n { text-align:right; font-family:var(--mono); } td.y { color:var(--ok); } td.no { color:var(--fix); font-weight:600; }
tr.rfix td { background:color-mix(in srgb, var(--fix) 10%, transparent); } tr.rok td:first-child { box-shadow:inset 3px 0 var(--ok); }
.rt { display:inline-flex; gap:2px; } .rt button { font:12px var(--mono); width:24px; height:22px; border:1px solid var(--line); background:var(--panel); color:var(--muted); border-radius:3px; cursor:pointer; padding:0; }
.rt button[aria-pressed="true"][data-v="ok"] { background:var(--ok); color:#fff; border-color:var(--ok); } .rt button[aria-pressed="true"][data-v="fix"] { background:var(--fix); color:#fff; border-color:var(--fix); }
.rv { display:grid; gap:8px; border-top:1px dashed var(--line); padding-top:12px; }
.vb { display:flex; flex-wrap:wrap; gap:6px; } .vb button { font:600 13px var(--sans); padding:6px 12px; border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:3px; cursor:pointer; }
.vb button[aria-pressed="true"][data-v="ok"] { background:var(--ok); border-color:var(--ok); color:#fff; } .vb button[aria-pressed="true"][data-v="fix"] { background:var(--fix); border-color:var(--fix); color:#fff; } .vb button[aria-pressed="true"][data-v="q"] { background:var(--q); border-color:var(--q); color:#1b1300; }
textarea, input[type=text], input[type=date] { font:14px var(--sans); width:100%; box-sizing:border-box; padding:8px; border:1px solid var(--line); border-radius:3px; background:var(--panel); color:var(--ink); }
textarea { min-height:64px; resize:vertical; } .who { font:12px var(--mono); color:var(--muted); }
button:focus-visible, textarea:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline:2px solid var(--acc); outline-offset:2px; }
.sign { border:2px solid var(--ink); } .sign .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px; } .sign label { display:grid; gap:4px; font-size:13px; color:var(--muted); }
.primary { font:600 14px var(--sans); padding:9px 16px; background:var(--acc); color:#fff; border:0; border-radius:3px; cursor:pointer; justify-self:start; } .primary:disabled { opacity:.5; cursor:not-allowed; }
.v3 { position:relative; height:min(62vh, 560px); min-height:340px; background:#e4e3df; border:1px solid var(--line); } #cv3 { width:100%; height:100%; display:block; touch-action:none; }
.v3c { position:absolute; left:10px; top:10px; right:10px; display:flex; flex-wrap:wrap; gap:5px; } .v3c button { font:12px var(--mono); padding:4px 8px; border:1px solid #1c252d33; background:#ffffffd9; color:#1c252d; border-radius:3px; cursor:pointer; }
.v3c button[aria-pressed="false"] { opacity:.45; text-decoration:line-through; } .v3c button.own { border-color:#1f5fbf; } .v3c button:disabled { opacity:.5; cursor:not-allowed; text-decoration:none; }
.v3c button.only { font-weight:600; background:#1f5fbf; color:#fff; border-color:#1f5fbf; } .v3c button.only[aria-pressed="false"] { opacity:1; text-decoration:none; background:#ffffffd9; color:#1f5fbf; }
.v3i { position:absolute; left:10px; bottom:8px; font:12px var(--mono); color:#1c252d; background:#ffffffcc; padding:3px 6px; border-radius:3px; max-width:calc(100% - 20px); }
tr.hit td { background:color-mix(in srgb, var(--acc) 16%, transparent) !important; } tr[data-id] { cursor:pointer; }
footer.note { border-top:1px solid var(--line); padding-top:12px; }
.signed { display:grid; gap:4px; background:var(--soft); padding:10px 12px; } .note { font-size:13px; color:var(--muted); }
</style>
<div class="wrap">
<header><div class="eyebrow">__EYEBROW__</div>
<h1>__H1__</h1>
<p>__INTRO__ Mark each section <b>Accepted</b>, <b>Needs correction</b> or <b>Query</b>, tick or cross single rows, and write your notes; they are saved for the design team. Click a row to find the element in the model, or an element to find its row. When you are satisfied, sign off at the end.</p>
<p class="note">__BACK__</p></header>
<div class="v3" id="v3" __V3HIDE__><canvas id="cv3" aria-label="3D model of what is being reviewed"></canvas><div class="v3c" id="v3c" role="group" aria-label="Show or hide parts"></div><div class="v3i" id="v3i">drag to turn · right-drag to move · scroll to zoom · click an element</div></div>
<div class="bar" role="status"><b id="cnt"></b><div class="prog" id="prog" aria-hidden="true"></div><label class="note">Show <select id="flt"><option value="all">all sections</option><option value="open">not yet reviewed</option><option value="fix">needs correction or query</option></select></label><span class="note" id="dbn"></span></div>
<div class="gaps"><b>Open data, not yet available</b><ul>__GAPS__</ul></div>
<nav class="toc" id="toc" aria-label="Sections"></nav>
<div id="secs"></div>
<section class="sign" id="signoff"><h2>__SIGNER__: sign-off</h2>
<p>__STATEMENT__</p>
<div id="signedlist"></div>
<div class="grid"><label>Full name<input type="text" id="sg-name" autocomplete="name"></label><label>__REGLABEL__<input type="text" id="sg-reg"></label><label>Date<input type="date" id="sg-date"></label></div>
<label class="note"><input type="checkbox" id="sg-ok"> I confirm the statement above</label>
<button class="primary" id="sg-btn" disabled>Sign off</button><p class="note" id="sg-msg"></p></section>
<footer class="note">__CREDITS__</footer>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
<script>
const SECS = __SECS__;
const MESH = __MESH__;
(async function () {
  const $ = (id) => document.getElementById(id), esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const REV = {};   // section id -> {verdict, note, rows, by, at}
  const fmt = (v) => v === true ? '<td class="y">✓</td>' : v === false ? '<td class="no">✗</td>' : typeof v === "number" ? `<td class="n">${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>` : `<td>${esc(v)}</td>`;
  let db = null, user = null, canWrite = false, me = null;
  function sectionHTML(s, i) {
    const r = REV[s.id] || {}, rows = r.rows || {};
    return `<section id="s-${s.id}" class="${r.verdict || ""}" data-id="${s.id}"><div class="sh"><span>${String(i + 1).padStart(2, "0")}</span><h2>${esc(s.title)}</h2></div><p>${esc(s.intro)}</p>` +
      (s.eqs.length ? `<div class="eq">${s.eqs.map((x) => `<div>${esc(x)}</div>`).join("")}</div>` : "") +
      (s.rows.length ? `<div class="tw"><table><thead><tr><th>Check</th>${s.cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>` + s.rows.map((row) => { const v = rows[row[0]] || "";
        return `<tr class="${v ? "r" + v : ""}" data-id="${esc(row[0])}"><td><span class="rt" role="group" aria-label="Row ${esc(row[0])}"><button data-s="${s.id}" data-r="${esc(row[0])}" data-v="ok" aria-pressed="${v === "ok"}" title="This row is right" ${canWrite ? "" : "disabled"}>✓</button><button data-s="${s.id}" data-r="${esc(row[0])}" data-v="fix" aria-pressed="${v === "fix"}" title="This row needs correcting" ${canWrite ? "" : "disabled"}>✗</button></span></td>${row.slice(1).map(fmt).join("")}</tr>`; }).join("") + "</tbody></table></div>" : "") +
      `<div class="rv"><div class="vb" role="group" aria-label="Verdict">${[["ok", "Accepted"], ["fix", "Needs correction"], ["q", "Query"]].map(([v, l]) => `<button data-s="${s.id}" data-verdict="${v}" aria-pressed="${r.verdict === v}" ${canWrite ? "" : "disabled"}>${l}</button>`).join("")}</div>
       <textarea data-note="${s.id}" placeholder="Notes and corrections for this section" ${canWrite ? "" : "disabled"}>${esc(r.note || "")}</textarea><div class="who" data-who="${s.id}"></div></div></section>`;
  }
  async function who() {
    const ids = [...new Set(Object.values(REV).map((r) => r.by).filter(Boolean))]; const ps = user && ids.length ? await user.profiles(ids) : {};
    for (const s of SECS) { const r = REV[s.id], el = document.querySelector(`[data-who="${s.id}"]`); if (el) el.textContent = r && r.at ? `Last marked by ${(ps[r.by] && ps[r.by].name) || "a reviewer"} on ${new Date(r.at).toLocaleString()}` : ""; }
  }
  function render() {
    const f = $("flt").value, focus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.note : null;
    $("secs").innerHTML = SECS.map((s, i) => { const v = (REV[s.id] || {}).verdict; return f === "all" || (f === "open" && !v) || (f === "fix" && (v === "fix" || v === "q")) ? sectionHTML(s, i) : ""; }).join("");
    const n = { ok: 0, fix: 0, q: 0 }; SECS.forEach((s) => { const v = (REV[s.id] || {}).verdict; if (v) n[v]++; });
    $("cnt").textContent = `${n.ok + n.fix + n.q} / ${SECS.length} reviewed · ${n.ok} accepted · ${n.fix} to correct · ${n.q} queries`;
    $("prog").innerHTML = `<i style="flex:${n.ok};background:var(--ok)"></i><i style="flex:${n.fix};background:var(--fix)"></i><i style="flex:${n.q};background:var(--q)"></i><i style="flex:${SECS.length - n.ok - n.fix - n.q}"></i>`;
    $("toc").innerHTML = SECS.map((s, i) => `<a href="#s-${s.id}" class="${(REV[s.id] || {}).verdict || ""}">${String(i + 1).padStart(2, "0")} ${esc(s.title)}</a>`).join("");
    if (focus) { const t = document.querySelector(`[data-note="${focus}"]`); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
    who();
  }
  // one write at a time per section document
  const queue = {};
  async function save(id) {
    if (!db || !canWrite) return;
    if (queue[id]) { queue[id].again = true; return; } queue[id] = { again: false };
    try { do { queue[id].again = false; await db.doc("reviews/" + id).set(Object.assign({}, REV[id], { by: me, at: new Date().toISOString() })); } while (queue[id].again); $("dbn").textContent = "Saved"; }
    catch (x) { $("dbn").textContent = x && x.code === "invalid_argument" ? "You can read this pack but not mark it" : "Could not save: try again"; }
    delete queue[id];
  }
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-verdict]"); if (b) { const r = REV[b.dataset.s] = REV[b.dataset.s] || {}; r.verdict = r.verdict === b.dataset.verdict ? "" : b.dataset.verdict; render(); save(b.dataset.s); return; }
    const t = ev.target.closest(".rt button"); if (t) { const r = REV[t.dataset.s] = REV[t.dataset.s] || {}; r.rows = Object.assign({}, r.rows); r.rows[t.dataset.r] = r.rows[t.dataset.r] === t.dataset.v ? "" : t.dataset.v; render(); save(t.dataset.s); }
  });
  const timers = {};
  document.addEventListener("input", (ev) => { const n = ev.target.dataset && ev.target.dataset.note; if (!n) return; (REV[n] = REV[n] || {}).note = ev.target.value; clearTimeout(timers[n]); timers[n] = setTimeout(() => save(n), 900); });
  $("flt").onchange = render;
  render();
  // ---- 3D: one mesh per element (from the export's element ranges), so rows and elements find each other
  const EL = {}; let focus = () => {};
  if (MESH && window.THREE) try {
    const cv = $("cv3"), r = new THREE.WebGLRenderer({ canvas: cv, antialias: true }); r.setPixelRatio(Math.min(2, devicePixelRatio || 1)); r.outputEncoding = THREE.sRGBEncoding;
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#e4e3df"); const cam = new THREE.PerspectiveCamera(34, 1, 0.05, 2000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0a6, 0.9)); const sun = new THREE.DirectionalLight(0xffffff, 0.7); sun.position.set(-1, 2, 1.2); scene.add(sun);
    const inflate = async (b64) => new Uint8Array(await new Response(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    const CAT = {}, all = new THREE.Group(); scene.add(all);
    for (const g of MESH.groups) {
      const o = g.offset || MESH.offset, s = g.scale || MESH.scale;   // groups merged from another model keep their own quantisation
      const q = new Uint16Array((await inflate(g.pos)).buffer), raw = (await inflate(g.idx)).buffer, idx = g.i32 ? new Uint32Array(raw) : new Uint16Array(raw), n = g.verts;
      const pos = new Float32Array(n * 3); for (let v = 0; v < n; v++) { pos[3 * v] = o[0] + q[3 * v] * s; pos[3 * v + 1] = o[2] + q[3 * v + 2] * s; pos[3 * v + 2] = -(o[1] + q[3 * v + 1] * s); }
      const pa = new THREE.BufferAttribute(pos, 3), col = g.color || (MESH.colors || {})[g.cat] || "#c9cdd0";
      const lab = g.label || (MESH.labels || {})[g.cat] || (MESH.labels || {})["*"] || g.cat;   // categories grouped into the parts a reviewer thinks in
      const grp = CAT[lab] = CAT[lab] || new THREE.Group(); all.add(grp);
      for (const [id, t0, nt] of (g.els || [[0, 0, g.tris]])) {
        const geo = new THREE.BufferGeometry(); geo.setAttribute("position", pa); geo.setIndex(new THREE.BufferAttribute(idx.slice(t0 * 3, (t0 + nt) * 3), 1)); geo.computeVertexNormals();
        const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, roughness: 0.9, flatShading: true, side: THREE.DoubleSide, transparent: g.glass, opacity: g.glass ? 0.35 : 1 }));
        m.userData = { id: String(id), cat: g.cat }; grp.add(m); (EL[String(id)] = EL[String(id)] || []).push(m);
      }
    }
    const bb = new THREE.Box3().setFromObject(all), c = bb.getCenter(new THREE.Vector3()), R = bb.getSize(new THREE.Vector3()).length();
    cam.position.copy(c).add(new THREE.Vector3(R * 0.55, R * 0.45, R * 0.65)); const ctl = new THREE.OrbitControls(cam, cv); ctl.target.copy(c); ctl.enableDamping = true; ctl.screenSpacePanning = true; ctl.saveState();
    // "Only <discipline>": the reviewer's own elements alone (MESH.mine: the part names of this discipline); off = everything
    const mine = (MESH.mine || []).filter((k) => CAT[k]);
    const onlyBtn = MESH.mineLabel ? `<button class="only" data-only="1" aria-pressed="false" ${mine.length ? "" : "disabled title=\"Nothing of this discipline is modelled yet\""}>Only ${esc(MESH.mineLabel)}${mine.length ? "" : " (none modelled yet)"}</button>` : "";
    $("v3c").innerHTML = onlyBtn + Object.keys(CAT).map((k) => `<button data-cat="${esc(k)}" aria-pressed="true" class="${mine.includes(k) ? "own" : ""}">${esc(k)}</button>`).join("") + '<button data-home="1">Reset view</button>';
    const sync = () => document.querySelectorAll("#v3c [data-cat]").forEach((b) => b.setAttribute("aria-pressed", CAT[b.dataset.cat].visible));
    $("v3c").onclick = (ev) => {
      const b = ev.target.closest("button"); if (!b || b.disabled) return;
      if (b.dataset.home) { ctl.reset(); return; }
      if (b.dataset.only) { const on = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", on); Object.entries(CAT).forEach(([k, g]) => (g.visible = !on || mine.includes(k))); sync(); return; }
      const g = CAT[b.dataset.cat]; g.visible = !g.visible; b.setAttribute("aria-pressed", g.visible);
    };
    let lit = [];
    // the selected element in orange, everything else faded, so it reads at any distance
    const xray = (on) => Object.values(EL).flat().forEach((m) => { if (m.userData.op0 === undefined) m.userData.op0 = m.material.opacity; m.material.transparent = on || m.userData.op0 < 1; m.material.opacity = on ? 0.18 : m.userData.op0; m.material.depthWrite = !on; });
    focus = (id, fly) => {
      lit.forEach((m) => { m.material.color.copy(m.userData.col0); m.material.emissive.setHex(0); }); lit = EL[id] || [];
      xray(lit.length > 0);
      lit.forEach((m) => { m.userData.col0 = m.userData.col0 || m.material.color.clone(); m.material.color.set("#e8681e"); m.material.emissive.setHex(0x3a1400); m.material.opacity = 1; m.material.transparent = false; m.material.depthWrite = true; });
      if (lit.length) {
        const b = new THREE.Box3(); lit.forEach((m) => b.expandByObject(m)); $("v3i").textContent = `${lit[0].userData.cat} ${id} · click empty space to clear`;
        if (fly) { const cc = b.getCenter(new THREE.Vector3()), d = Math.max(b.getSize(new THREE.Vector3()).length() * 2.5, R * 0.12); ctl.target.copy(cc); cam.position.copy(cc).add(new THREE.Vector3(d * 0.6, d * 0.5, d * 0.7)); }
      }
    };
    const ray = new THREE.Raycaster(), mp = new THREE.Vector2(); let down = null;
    cv.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
    cv.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; const rc = cv.getBoundingClientRect();
      mp.set(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1); ray.setFromCamera(mp, cam);
      const h = ray.intersectObjects(all.children.filter((g) => g.visible), true)[0];
      if (!h) { focus("", false); document.querySelectorAll("tr.hit").forEach((t) => t.classList.remove("hit")); $("v3i").textContent = "click an element to find its row"; return; }
      const id = h.object.userData.id; focus(id, false);
      document.querySelectorAll("tr.hit").forEach((t) => t.classList.remove("hit")); const rows = [...document.querySelectorAll(`tr[data-id="${CSS.escape(id)}"]`)];
      rows.forEach((t) => t.classList.add("hit")); if (rows[0]) rows[0].scrollIntoView({ block: "center", behavior: "smooth" }); else $("v3i").textContent += " (no row in this pack)";
    });
    const fit = () => { const w = cv.clientWidth, h = cv.clientHeight; r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }; addEventListener("resize", fit); fit();
    (function loop() { ctl.update(); r.render(scene, cam); requestAnimationFrame(loop); })();
  } catch (x) { $("v3i").textContent = "The 3D model could not be opened in this browser."; }
  document.addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-id]"); if (!tr || ev.target.closest("button")) return;
    document.querySelectorAll("tr.hit").forEach((t) => t.classList.remove("hit")); tr.classList.add("hit"); focus(tr.dataset.id, true);
    if (EL[tr.dataset.id]) $("v3").scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  // shared marks and sign-offs (database); the pack still reads without it
  [db, user] = await Promise.all([claude.use("db"), claude.use("user")]);
  if (!db) { $("dbn").textContent = "Marks cannot be saved in this view"; return; }
  me = user ? await user.id() : null; const cw = user ? await user.can("data.write") : null; canWrite = !!me && cw !== false;
  $("dbn").textContent = canWrite ? "Your marks save as you go" : "Read-only: ask Formcraft for reviewer access";
  db.collection("reviews").onSnapshot((snap) => {
    let changed = false;
    snap.docChanges().forEach((c) => { if (queue[c.doc.id]) return; if (c.type === "removed") delete REV[c.doc.id]; else REV[c.doc.id] = Object.assign({}, c.doc.data()); changed = true; });
    if (changed) render();
  }, () => { $("dbn").textContent = "Marks are not updating: reload the page"; });
  db.collection("signoff").onSnapshot(async (snap) => {
    const ss = snap.docs.map((x) => x.data()); const ps = user ? await user.profiles(snap.docs.map((x) => x.id)) : {};
    $("signedlist").innerHTML = ss.map((x, i) => `<div class="signed"><b>Signed: ${esc(x.name)}, ${esc(x.reg)}, ${esc(x.date)}</b><span class="note">by ${esc((ps[snap.docs[i].id] || {}).name || "the account holder")}; ${esc(x.summary)}</span></div>`).join("");
  }, () => {});
  const chk = () => { $("sg-btn").disabled = !(canWrite && $("sg-ok").checked && $("sg-name").value.trim() && $("sg-reg").value.trim() && $("sg-date").value); };
  ["sg-ok", "sg-name", "sg-reg", "sg-date"].forEach((id) => $(id).addEventListener("input", chk)); $("sg-ok").addEventListener("change", chk);
  $("sg-btn").onclick = async () => {
    const n = { ok: 0, fix: 0, q: 0 }; SECS.forEach((s) => { const v = (REV[s.id] || {}).verdict; if (v) n[v]++; });
    try { await db.doc("signoff/" + me).set({ name: $("sg-name").value.trim(), reg: $("sg-reg").value.trim(), date: $("sg-date").value, at: new Date().toISOString(), summary: `${n.ok} sections accepted, ${n.fix} to correct, ${n.q} queries of ${SECS.length}` }); $("sg-msg").textContent = "Signed off and saved."; }
    catch (x) { $("sg-msg").textContent = "The sign-off could not be saved."; }
  };
})();
</script>"""
CREDITS = "Prepared with Autodesk Revit, Autodesk Robot Structural Analysis and the Formcraft Construction plugin (Formcraft Revit Tools)."
def render(sections, meta, mesh=None):
    """sections: [{id, title, intro, eqs, cols, rows: [[row id, cells...]]}]; meta: title, eyebrow, h1, intro, back (html),
    signer, statement, reglabel, gaps (list), credits; mesh: a web mesh (obj2web.py) plus colors / labels per category."""
    e = html.escape
    sub = {"__TITLE__": e(meta["title"]), "__EYEBROW__": e(meta["eyebrow"]), "__H1__": e(meta["h1"]), "__INTRO__": e(meta["intro"]), "__BACK__": meta.get("back", ""),
           "__SIGNER__": e(meta.get("signer", "Professional")), "__STATEMENT__": e(meta.get("statement", "")), "__REGLABEL__": e(meta.get("reglabel", "Registration number")),
           "__GAPS__": "".join(f"<li>{e(x)}</li>" for x in meta.get("gaps", [])) or "<li>None recorded</li>", "__CREDITS__": e(meta.get("credits", CREDITS)),
           "__V3HIDE__": "" if mesh else "hidden", "__MESH__": json.dumps(mesh, separators=(",", ":")) if mesh else "null",
           "__SECS__": json.dumps(sections, separators=(",", ":"), ensure_ascii=False).replace("</", "<" + chr(92) + "/")}
    out = PAGE
    for k, v in sub.items(): out = out.replace(k, v)
    return out
