/** send_code_to_revit permission first: reason, Stop AI / code switch, lease, a person's single-use approval. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CODE_GATE, GateInput, boundParams, codeAlternatives, codeDetails, codeGate, sameCall } from "./codegate.js";
import type { AiModellerConfig } from "./aiuse.js";

const doc = "C:\\P\\01_WIP\\A\\P-ORG-ZZ-00-M3-A-0001.rvt";
const ai = (over: Partial<AiModellerConfig> = {}): AiModellerConfig => ({ on: true, stop: false, allow_code: true, projects: {}, levels: {}, ...over });
const call = { code: "var w = Wall.Create(doc, line, level, false);\nreturn null;", reason: "no_tool" as string | undefined, transactionMode: "auto" };
const base = (over: Partial<GateInput> = {}): GateInput => ({
  call, document: doc, lease: "L1", leaseDocuments: [doc], leaseCovers: (h, a) => h.toLowerCase() === a.toLowerCase(), ai: ai(), queued: null, ...over,
});
const approved = (by = "USER", params: unknown = boundParams(call)) => ({ id: "abc12345", command: "send_code_to_revit", model: "m", path: doc, group: "code", elements: 1,
  summary: "send_code_to_revit", created: "", status: "approved" as const, by, params });

test("CODE no reason, or tool_error without the failing tool: refused before anything is queued", () => {
  const r = codeGate(base({ call: { ...call, reason: undefined } }));
  assert.equal(r.ok, false); assert.equal(!r.ok && r.code, CODE_GATE.REASON); assert.equal(!r.ok && r.enqueue, undefined);
  const t = codeGate(base({ call: { ...call, reason: "tool_error" } }));
  assert.equal(!t.ok && t.code, CODE_GATE.REASON);
  assert.equal(codeGate(base({ call: { ...call, reason: "because" } })).ok, false);
});

test("CODE Stop AI and the admin's code switch refuse", () => {
  assert.equal((codeGate(base({ ai: ai({ stop: true }) })) as { code: string }).code, CODE_GATE.STOPPED);
  assert.equal((codeGate(base({ ai: ai({ allow_code: false }) })) as { code: string }).code, CODE_GATE.SWITCH);
});

test("CODE no lease, or a lease on another document: refused, nothing queued", () => {
  const r = codeGate(base({ lease: undefined, leaseDocuments: [] }));
  assert.equal(!r.ok && r.code, CODE_GATE.NO_LEASE); assert.equal(!r.ok && r.enqueue, undefined);
  assert.equal((codeGate(base({ leaseDocuments: ["C:\\Other.rvt"] })) as { code: string }).code, CODE_GATE.NO_LEASE);
  assert.equal((codeGate(base({ document: "" , documentProblem: "2 documents are open" })) as { code: string }).code, CODE_GATE.NO_DOC);
});

test("CODE first call queues for a person and suggests tools while it waits", () => {
  const r = codeGate(base());
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, CODE_GATE.APPROVAL); assert.equal(r.enqueue, true);
  assert.ok(r.alternatives!.some((a) => a.includes("create_line_based_element")));
  assert.ok(r.alternatives!.some((a) => a.includes("fmc_scripts addon_list")));
  assert.match(r.message, /fmc_ai wait/);
});

test("CODE full access and testing auto-approve do not skip the person (the gate never reads them)", () => {
  const r = codeGate(base({ ai: ai({ access: "full", mode: "testing", auto_approve: true }) }));
  assert.equal(!r.ok && r.code, CODE_GATE.APPROVAL);
  const auto = codeGate(base({ queued: approved("auto-approved (testing)") }));
  assert.equal(auto.ok, false, "an auto-approved record is not a person's approval");
});

test("CODE read_only mode needs the approval too (code can still write files)", () => {
  const r = codeGate(base({ call: { ...call, transactionMode: "read_only" } }));
  assert.equal(!r.ok && r.code, CODE_GATE.APPROVAL);
});

test("CODE pending waits, rejected stays rejected, a different call does not match", () => {
  assert.equal((codeGate(base({ queued: { ...approved(), status: "pending" } })) as { code: string; enqueue?: boolean }).enqueue, undefined);
  assert.equal((codeGate(base({ queued: { ...approved(), status: "rejected" } })) as { code: string }).code, CODE_GATE.REJECTED);
  const other = codeGate(base({ queued: approved("USER", boundParams({ ...call, code: "return 1;" })) }));
  assert.equal(!other.ok && other.code, CODE_GATE.MISMATCH);
});

test("CODE a person's approval of exactly this call passes; a used one asks again", () => {
  const r = codeGate(base({ queued: approved("USER") }));
  assert.deepEqual(r, { ok: true, approvalId: "abc12345", by: "USER" });
  const used = codeGate(base({ queued: { ...approved(), status: "used" as never } }));
  assert.equal(!used.ok && used.enqueue, true);
});

test("CODE tool_error suggests the failing tool first; details carry reason and hash", () => {
  const c = { ...call, reason: "tool_error", failing_tool: "modify_model", failing_error: "op not found" };
  assert.match(codeAlternatives(c)[0], /^modify_model again/);
  const d = codeDetails(c, doc).join("\n");
  assert.match(d, /modify_model failed: op not found/); assert.match(d, /SHA-256 [0-9a-f]{12}/);
  assert.equal(sameCall(boundParams(c), { ...boundParams(c), document: "x" }), true, "document is bound by the queue key, not params");
});

test("CODE tool: no reason is refused at the tool before Revit; a named document that is not open is refused", async () => {
  const { runSendCode } = await import("../tools/send_code_to_revit.js");
  const r = await runSendCode({ code: "return null;" });
  assert.equal(r.isError, true); assert.match(r.content[0].text, /FMC-CODE-REASON/);
  const { documentTarget } = await import("./target.js");
  const r2 = await documentTarget.run("Nope.rvt", () => runSendCode({ code: "return null;", reason: "no_tool" }));
  assert.equal(r2.isError, true); assert.match(r2.content[0].text, /FMC-CODE-(NO-DOCUMENT|SWITCH-OFF|STOPPED)/);
});

test("CODE pane approve of a send_code item does not run it; wait tells the AI to resend", async () => {
  const { enqueue, readItem } = await import("./aiuse_io.js");
  const { paneAi, waitFor } = await import("../tools/fmc_ai.js");
  fs.mkdirSync(path.join(process.env.APPDATA ?? "", "Formcraft"), { recursive: true });
  const item = enqueue("send_code_to_revit", boundParams(call), doc, "m", "code", 1);
  const r = await paneAi("ai_approve", { id: item.id }, "USER") as { ran?: boolean; result?: string };
  assert.equal(r.ran, false); assert.equal(r.result, "approved");
  assert.equal(readItem(item.id)?.status, "approved");
  const w = await waitFor(item.id, 1, async () => {}) as { status?: string; next?: string };
  assert.equal(w.status, "approved"); assert.match(String(w.next), /send the same send_code_to_revit call again/);
});
