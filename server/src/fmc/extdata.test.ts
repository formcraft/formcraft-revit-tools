import { test } from "node:test";
import assert from "node:assert/strict";
import { placeOf, redact, rootsOf, stripUrl, summarise, R25_NOTES } from "./extdata.js";
import { WRITE_COMMANDS, DEFAULT_CONFIG } from "./policy.js";
import { COMMAND_GROUPS } from "./aiuse.js";

const roots = { kit: "C:\\FMC_Kit", blocked_segments: ["02_Shared", "03_Published"], protected_roots: ["D:\\Originals"] };

test("a credential-shaped key or value is never reported", () => {
  assert.equal(redact("access_token", "abc"), "[redacted]");
  assert.equal(redact("ClientSecret", "x"), "[redacted]");
  assert.equal(redact("Authorization", "Bearer x"), "[redacted]");
  assert.equal(redact("note", "eyJhbGciOi.eyJzdWIiOi.sig"), "[redacted]");
  assert.equal(redact("blob", "A".repeat(48)), "[redacted]");
  assert.equal(redact("KeynoteFile", "C:\\Kit\\keynotes.txt"), "C:\\Kit\\keynotes.txt", "a key that merely contains 'key' is not hidden");
  assert.equal(redact("projectGuid", "7b3f"), "7b3f");
});

test("a URL loses its user:password, query and fragment", () => {
  assert.equal(stripUrl("https://u:p@host.example/a/b.rvt?sig=SECRET&x=1#f"), "https://host.example/a/b.rvt?[redacted]");
  assert.equal(stripUrl("C:\\a\\b.rvt"), "C:\\a\\b.rvt");
  assert.ok(!stripUrl("https://host/p?token=abc").includes("abc"));
});

test("placeOf says kit, CDE gate folder or protected root, case-insensitively, and no local path for cloud links", () => {
  assert.equal(placeOf("c:\\fmc_kit\\03_Master_Data\\x.json", roots).in_kit, true);
  assert.equal(placeOf("Z:\\P\\02_shared\\S\\a.rvt", roots).cde_gate_folder, "02_Shared");
  assert.equal(placeOf("D:\\Originals\\a.rvt", roots).in_protected_root, true);
  assert.equal(placeOf("Z:\\P\\01_WIP\\a.rvt", roots).where, "elsewhere");
  assert.match(placeOf("", roots).where, /no local path/);
  assert.equal(placeOf("C:\\FMC_Kit\\..\\Other\\a.rvt", roots).in_kit, false, "a .. that leaves the kit is not in the kit");
});

test("summarise reports counts and roots, redacts again, and states the R25 limit", () => {
  const out = summarise({
    model: "A-0001", revit: "2025",
    external_files: [
      { element_id: 1, type: "RevitLink", status: "Loaded", path: "Z:\\P\\02_Shared\\S\\s.rvt", path_type: "Relative" },
      { element_id: 2, type: "RevitLink", status: "NotFound", path: "https://u:p@srv/x.rvt?sig=ZZ" },
      { element_id: 3, type: "KeynoteTable", status: "Loaded", path: "C:\\FMC_Kit\\keynotes.txt" },
    ],
    external_resources: [{ element_id: 5, server_id: "g", reference_info: { project: "p1", access_token: "T0K3N", url: "https://h/x?key=SECRET" }, in_session_path: "https://a:b@h/x" }],
    servers: [{ server_id: "g", name: "Revit local" }], warnings: [],
  }, roots) as any;
  assert.equal(out.read_only, true);
  assert.deepEqual(out.counts.by_type, { RevitLink: 2, KeynoteTable: 1 });
  assert.equal(out.counts.not_loaded, 1);
  assert.equal(out.counts.in_cde_gate_folders, 1);
  assert.equal(out.external_files[2].in_kit, true);
  assert.equal(out.external_resources[0].reference_info.access_token, "[redacted]");
  assert.equal(out.external_resources[0].reference_info.project, "p1");
  assert.ok(!JSON.stringify(out).includes("SECRET") && !JSON.stringify(out).includes("T0K3N") && !JSON.stringify(out).includes("u:p@"));
  assert.deepEqual(out.roots.cde_gate_folders, ["02_Shared", "03_Published"]);
  assert.match(out.r25.join(" "), /Revit 2027/);
  assert.ok(R25_NOTES.length >= 3);
});

test("a missing or empty add-in reply is an empty, honest list, not an error", () => {
  const out = summarise({}, roots) as any;
  assert.equal(out.counts.files, 0);
  assert.deepEqual(out.external_files, []);
  assert.equal(out.read_only, true);
});

test("fmc_external_data is a read: not in WRITE_COMMANDS, not an AI-group write, and rootsOf copies the guard's lists", () => {
  assert.ok(!WRITE_COMMANDS.has("fmc_external_data"));
  assert.ok(!JSON.stringify(COMMAND_GROUPS).includes("fmc_external_data"));
  const r = rootsOf({ ...DEFAULT_CONFIG, blocked_segments: ["02_Shared"], protected_roots: ["D:\\X"] } as any, "C:\\Kit");
  assert.deepEqual(r, { kit: "C:\\Kit", blocked_segments: ["02_Shared"], protected_roots: ["D:\\X"] });
});