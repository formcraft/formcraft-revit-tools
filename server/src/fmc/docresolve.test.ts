import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentsMatch } from "./batchline.js";
import { documentRequired } from "./fairqueue.js";
import {
  DOC_AMBIGUOUS, DOC_NOT_FOUND, DOC_REQUIRED, attachResolvedDocument, leaseCovers, preferUnstrippedDocument, resolvedDocumentFrom, resolveLeaseDocument, resolveOpenDocument,
} from "./docresolve.js";
import { shapeKeynoteResult } from "./keynote.js";
import { formatCodeResult } from "../tools/send_code_to_revit.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const open = [
  { title: "S-0001", path: "D:\\Jobs\\_Staging\\S-0001.rvt", family: false },
  { title: "E-0001", path: "D:\\Jobs\\_Staging\\E-0001.rvt", family: false },
  { title: "P-0001", path: "D:\\Jobs\\_Staging\\P-0001.rvt", family: false },
  { title: "A-0002_USER", path: "D:\\Jobs\\_Staging\\A-0002_USER.rvt", family: false },
];

test("an explicit path resolves to that document and never the active one", () => {
  const named = "D:\\Jobs\\_Staging\\S-0001.rvt";
  const hit = resolveOpenDocument({ named, open, allowOmit: false });
  assert.equal(hit.ok, true);
  if (hit.ok) {
    assert.equal(hit.document?.title, "S-0001");
    assert.equal(hit.document?.path, named);
    assert.notEqual(hit.document?.title, "E-0001");
    assert.equal(hit.pin, true);
  }
  assert.equal(documentRequired("ai_element_filter", open, named), undefined);
  const slash = resolveOpenDocument({ named: "D:/Jobs/_Staging/S-0001.rvt", open });
  assert.equal(slash.ok && slash.document?.title, "S-0001");
  const title = resolveOpenDocument({ named: "A-0002_USER", open });
  assert.equal(title.ok && title.document?.path, "D:\\Jobs\\_Staging\\A-0002_USER.rvt");
});

test("a missing document is FMC-DOC-NOT-FOUND and a shared title is FMC-DOC-AMBIGUOUS", () => {
  const missing = resolveOpenDocument({ named: "D:\\Jobs\\_Staging\\missing.rvt", open });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, DOC_NOT_FOUND);
    assert.match(missing.message, /Refusing to use the active document/);
  }
  assert.match(documentRequired("ai_element_filter", open, "not-a-model") ?? "", /FMC-DOC-NOT-FOUND/);
  const stem = resolveOpenDocument({ named: "S-0001.rvt", open });
  assert.equal(stem.ok, false);
  if (!stem.ok) assert.equal(stem.code, DOC_NOT_FOUND);
  const same = [
    { title: "S-0001", path: "D:\\a\\S-0001.rvt" },
    { title: "S-0001", path: "D:\\b\\S-0001.rvt" },
  ];
  const ambiguous = resolveOpenDocument({ named: "S-0001", open: same });
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.code, DOC_AMBIGUOUS);
});

test("several project documents and no name is FMC-DOC-REQUIRED; one project is that project", () => {
  const refused = resolveOpenDocument({ open, allowOmit: false });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, DOC_REQUIRED);
  assert.match(documentRequired("fmc_model_edit", open, undefined) ?? "", /FMC-DOC-REQUIRED/);
  assert.match(documentRequired("create_grid", open, undefined) ?? "", /FMC-DOC-REQUIRED/);
  assert.match(documentRequired("delete_element", open, undefined) ?? "", /FMC-DOC-REQUIRED/);
  const only = resolveOpenDocument({ open: [open[0]] });
  assert.equal(only.ok && only.document?.title, "S-0001");
  const withFamilies = resolveOpenDocument({
    open: [open[0], { title: "FMC_A_Door", path: "D:\\Fam\\FMC_A_Door.rfa", family: true }],
  });
  assert.equal(withFamilies.ok && withFamilies.document?.title, "S-0001");
  assert.equal(documentRequired("fmc_document_info", open, undefined), undefined);
  assert.equal(resolveOpenDocument({ named: "nowhere", open: [] }).ok, true);
});

test("a batch lease for another document does not cover the write", () => {
  const structural = { title: "S-0001", path: "D:\\Jobs\\_Staging\\S-0001.rvt" };
  const electrical = { title: "E-0001", path: "D:\\Jobs\\_Staging\\E-0001.rvt" };
  assert.equal(leaseCovers("S-0001", structural, documentsMatch), true);
  assert.equal(leaseCovers(structural.path, structural, documentsMatch), true);
  assert.equal(leaseCovers("E-0001", structural, documentsMatch), false);
  assert.equal(leaseCovers(electrical.path, structural, documentsMatch), false);
});

test("a stripped _USER name never replaces the local title", () => {
  const local = "F26901-FMC-ZZ-ZZ-M3-E-0001_USER";
  const stripped = "F26901-FMC-ZZ-ZZ-M3-E-0001";
  assert.equal(preferUnstrippedDocument(stripped, local), local);
  assert.equal(preferUnstrippedDocument(local, stripped), local);
  assert.equal(preferUnstrippedDocument(undefined, local), local);
  assert.equal(resolveLeaseDocument(local, [{ title: local, path: "" }]), local);
  assert.equal(resolveLeaseDocument(stripped, [{ title: local, path: "C:\\Users\\USER\\Documents\\" + local + ".rvt" }]), local);
  assert.equal(resolveLeaseDocument(local, [{ title: stripped, path: "" }]), local);
});

test("ai_element_filter and undo resolve the named document in the add-in, not ActiveUIDocument", () => {
  const filter = fs.readFileSync(path.join(root, "commandset", "Services", "AIElementFilterEventHandler.cs"), "utf8");
  assert.match(filter, /FmcCallContext\.Document\(uiApp\)/);
  assert.doesNotMatch(filter, /ActiveUIDocument/);
  const undo = fs.readFileSync(path.join(root, "commandset", "Bridge", "FmcUndo.cs"), "utf8");
  const handler = undo.slice(undo.indexOf("class FmcUndoHandler"));
  assert.match(handler, /FmcTarget\.Resolve\(app, Parameters, mayOpen: false\)/);
  assert.match(handler, /BatchDocument\(batchId\)/);
  assert.doesNotMatch(handler, /ActiveUIDocument\?\.Document \?\? throw/);
  const script = fs.readFileSync(path.join(root, "commandset", "Bridge", "FmcScriptSource.cs"), "utf8");
  assert.match(script, /Document doc = document;/);
  const send = fs.readFileSync(path.join(root, "commandset", "Commands", "ExecuteDynamicCode", "ExecuteCodeEventHandler.cs"), "utf8");
  assert.match(send, /FmcTarget\.Resolve\(app, _parameters, mayOpen: false\)/);
  assert.match(send, /ResolvedDocument = FmcTarget\.Resolved\(doc\)/);
});

test("a string document and an object document both become resolved_document", () => {
  const fromString = shapeKeynoteResult({
    success: true,
    document: "A-0002_USER",
    result: { applied: true, ops: [{ kind: "keynote_audit", blank: 3, linked: [] }] },
  }, true);
  assert.deepEqual(fromString.body.resolved_document, { title: "A-0002_USER", path: "" });
  assert.deepEqual(fromString.body.document, { title: "A-0002_USER", path: "" });
  const fromObject = shapeKeynoteResult({
    success: false,
    errorMessage: "rolled back",
    resolved_document: { title: "A-0002_USER", path: "D:\\Jobs\\_Staging\\A-0002_USER.rvt" },
    document: "A-0002_USER",
  }, false);
  assert.equal(fromObject.isError, true);
  assert.deepEqual(fromObject.body.resolved_document, { title: "A-0002_USER", path: "D:\\Jobs\\_Staging\\A-0002_USER.rvt" });
  const shaped = formatCodeResult({
    success: true,
    result: "{\"ok\":true}",
    document: "S-0001",
    resolved_document: { title: "S-0001", path: "D:\\Jobs\\_Staging\\S-0001.rvt" },
  });
  assert.equal(shaped.isError, false);
  assert.match(shaped.text, /"resolved_document"/);
  assert.match(shaped.text, /S-0001\.rvt/);
  assert.deepEqual(resolvedDocumentFrom("D:\\WIP\\Site.rvt"), { title: "Site", path: "D:\\WIP\\Site.rvt" });
  const stamped = attachResolvedDocument({ ok: true }, { title: "P-0001", path: "D:\\P-0001.rvt" }) as unknown as { resolved_document: { title: string } };
  assert.equal(stamped.resolved_document.title, "P-0001");
  assert.equal(attachResolvedDocument(stamped, { title: "E-0001", path: "" }), stamped);
});
