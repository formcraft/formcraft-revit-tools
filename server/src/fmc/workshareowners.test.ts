import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  NEVER, WORKSET_OWNED_BY_OTHER, buildOwnersReport, checkOps, elementRows, normalizeCurrency, normalizeOwnersFacts, opTargets, opWorksets, ownerSummary, worksetRows,
} from "./workshareowners.js";
import { NOT_CURRENT, OWNED_BY_OTHER } from "./coordination.js";
import {
  FMC_WORKSHARE_OWNERS_SHAPE, FmcWorkshareOwnersArgs, MAX_ELEMENT_IDS, OWNERS_COMMANDS, registerFmcWorkshareOwnersTool, runFmcWorkshareOwners,
} from "../tools/fmc_workshare_owners.js";

const ws = (id: number, name: string, owner: string, open = true) => ({ id, name, owner, open, editable: owner === "ANN", default_visible: true });
const FACTS = normalizeOwnersFacts({
  model: "F26001-A.rvt", workshared: true, user: "ANN", central: "C:\\c.rvt",
  worksets: [ws(1, "A_Shell", "ANN"), ws(2, "A_Interior", "BOB"), ws(3, "S_Frame", ""), ws(4, "Z_Grids_Levels", "", false)],
});
assert.ok(FACTS);
const facts = FACTS!;
const ROWS = [
  { id: "10", checkout: "OwnedByOtherUser", owner: "BOB", updates: "CurrentWithCentral" },
  { id: "11", checkout: "OwnedByCurrentUser", owner: "ANN", updates: "CurrentWithCentral" },
  { id: "12", checkout: "NotOwned", owner: "", updates: "CurrentWithCentral" },
  { id: "13", checkout: "NotOwned", owner: "", updates: "UpdatedInCentral" },
  { id: "14", checkout: "NotOwned", owner: "", updates: "DeletedInCentral" },
];
const inp = (over: { rows?: typeof ROWS | null; element_worksets?: Record<string, string> } = {}) => ({
  facts, rows: over.rows === undefined ? ROWS : over.rows, element_worksets: over.element_worksets ?? {},
});

test("facts and currency are read defensively", () => {
  assert.equal(normalizeOwnersFacts("x"), null);
  assert.equal(normalizeOwnersFacts({ workshared: false })?.worksets.length, 0);
  assert.equal(normalizeCurrency({}), null);
  assert.equal(normalizeCurrency(null), null);
  assert.deepEqual(normalizeCurrency({ elements: [{ id: 5, checkout: "NotOwned" }] }), [{ id: "5", owner: "", checkout: "NotOwned", updates: "" }]);
});

test("worksets: yours, someone else's, nobody's", () => {
  const rows = worksetRows(facts);
  assert.deepEqual(rows.map((r) => [r.name, r.state, r.can_edit]), [
    ["A_Shell", "yours", "yes"], ["A_Interior", "others", "no"], ["S_Frame", "unowned", "by_borrowing"], ["Z_Grids_Levels", "unowned", "by_borrowing"],
  ]);
  assert.match(rows[1].note, /Owned by BOB/);
  assert.match(rows[1].note, /only they can relinquish/);
  assert.match(rows[3].note, /Closed in this model/);
  // owner names compare without case
  const lower = normalizeOwnersFacts({ workshared: true, user: "ann", worksets: [ws(1, "A_Shell", "ANN")] });
  assert.equal(worksetRows(lower!)[0].state, "yours");
});

test("owners: each person with their worksets, and the elements checked for them", () => {
  const els = elementRows(["10", "11", "12"], inp());
  const owners = ownerSummary(facts, els);
  assert.deepEqual(owners.map((o) => [o.owner, o.you, o.worksets, o.elements_checked]), [["ANN", true, ["A_Shell"], 1], ["BOB", false, ["A_Interior"], 1]]);
});

test("can I edit this element: each rule, in order", () => {
  const r = Object.fromEntries(elementRows(["10", "11", "12", "13", "14", "99"], inp()).map((e) => [e.id, e]));
  assert.equal(r["10"].can_edit, false);
  assert.equal(r["10"].code, OWNED_BY_OTHER);
  assert.equal(r["10"].owner, "BOB");
  assert.equal(r["11"].can_edit, true);
  assert.equal(r["11"].basis, "owned_by_you");
  assert.equal(r["12"].can_edit, true);
  assert.equal(r["12"].basis, "will_borrow");
  assert.match(r["12"].note, /workset is not known/);
  assert.equal(r["13"].code, NOT_CURRENT);
  assert.equal(r["14"].code, NOT_CURRENT);
  assert.match(r["14"].note, /Deleted in central/);
  assert.equal(r["99"].can_edit, null);
  assert.equal(r["99"].basis, "unknown");
});

test("a free element in a workset someone else owns is blocked, in one you own or nobody owns it is not", () => {
  const r = Object.fromEntries(elementRows(["12"], inp({ element_worksets: { "12": "a_interior" } })).map((e) => [e.id, e]));
  assert.equal(r["12"].can_edit, false);
  assert.equal(r["12"].code, WORKSET_OWNED_BY_OTHER);
  assert.match(r["12"].note, /A_Interior is owned by BOB/);
  assert.equal(elementRows(["12"], inp({ element_worksets: { "12": "A_Shell" } }))[0].basis, "will_borrow");
  assert.equal(elementRows(["12"], inp({ element_worksets: { "12": "S_Frame" } }))[0].workset_known, true);
  // an element held by another user stays that code even in a workset of yours
  assert.equal(elementRows(["10"], inp({ element_worksets: { "10": "A_Shell" } }))[0].code, OWNED_BY_OTHER);
});

test("a model that is not workshared has nothing to block; no rows means unknown, not allowed", () => {
  const plain = normalizeOwnersFacts({ workshared: false, user: "ANN" })!;
  const e = elementRows(["1"], { facts: plain, rows: null, element_worksets: {} });
  assert.equal(e[0].can_edit, true);
  assert.equal(e[0].basis, "not_workshared");
  const noRows = elementRows(["1", "1", "2"], inp({ rows: null }));
  assert.equal(noRows.length, 2); // de-duplicated
  assert.ok(noRows.every((x) => x.can_edit === null));
  assert.match(noRows[0].note, /could not be read/);
});

test("planned ops: ids and worksets come from params, an op's own id is not an element", () => {
  assert.deepEqual(opWorksets({ a: { workset: "A_Shell" }, worksets: ["S_Frame", "X"] }).sort(), ["A_Shell", "S_Frame", "X"]);
  const t = opTargets({ id: "op-77", tool: "modify_elements", action: "move", params: { ids: [10, 11], nested: { element_ids: ["12"] }, workset: "A_Interior" } });
  assert.equal(t.label, "modify_elements move");
  assert.deepEqual(t.ids.sort(), ["10", "11", "12"]);
  assert.deepEqual(t.worksets, ["A_Interior"]);
  const bare = opTargets({ label: "Doors", element_ids: ["5"], worksets: ["S_Frame"] });
  assert.deepEqual([bare.label, bare.ids, bare.worksets], ["Doors", ["5"], ["S_Frame"]]);
});

test("planned ops: clear, partly blocked, blocked, unknown, workset-only and no targets", () => {
  const v = checkOps([
    { label: "all mine", params: { ids: ["11", "12"] } },
    { label: "mixed", params: { ids: ["10", "12"] } },
    { label: "all theirs", params: { ids: ["10"] } },
    { label: "stale", params: { ids: ["13"] } },
    { label: "no row", params: { ids: ["12", "99"] } },
    { label: "new in their workset", params: { workset: "A_Interior" } },
    { label: "new in free workset", params: { workset: "S_Frame" } },
    { label: "nothing", params: { name: "x" } },
  ], inp());
  assert.deepEqual(v.map((x) => x.verdict), ["clear", "partly_blocked", "blocked", "blocked", "unknown", "blocked", "clear", "no_targets"]);
  assert.deepEqual(v[1].would_run_for, ["12"]);
  assert.deepEqual(v[1].would_skip.map((s) => [s.id, s.code, s.owner]), [["10", OWNED_BY_OTHER, "BOB"]]);
  assert.equal(v[1].needs_person, true);
  assert.match(v[1].next, /Ask BOB to sync and relinquish/);
  assert.match(v[1].next, /never relinquishes, syncs or checks out/);
  assert.match(v[3].next, /reloads latest/);
  assert.deepEqual(v[4].unknown, ["99"]);
  assert.deepEqual(v[5].blocked_worksets, [{ name: "A_Interior", owner: "BOB" }]);
  assert.equal(v[0].needs_person, false);
  assert.equal(v[0].next, "");
});

test("the report names its gaps and what it will never do", () => {
  const rep = buildOwnersReport(facts, ROWS, ["10", "12"], [{ label: "m", params: { ids: ["10"] } }], {});
  assert.equal(rep.read_only, true);
  assert.deepEqual(rep.never, NEVER);
  for (const word of ["relinquish", "synchronise", "checkout"]) assert.ok(rep.never.includes(word));
  assert.equal(rep.summary.worksets_yours, 1);
  assert.equal(rep.summary.worksets_others, 1);
  assert.equal(rep.summary.worksets_unowned, 2);
  assert.equal(rep.summary.elements_blocked, 1);
  assert.equal(rep.summary.ops_blocked, 1);
  assert.equal(rep.editing_requests.granted, false);
  assert.ok(rep.gaps.some((g) => /no model-wide list of borrowed elements/.test(g)));
  assert.ok(rep.gaps.some((g) => /does not return an element's workset/.test(g)));
  assert.ok(rep.gaps.some((g) => /editing requests/.test(g)));
  const noCurrency = buildOwnersReport(facts, null, ["10"], [], {}, { currencyError: "unknown command" });
  assert.ok(noCurrency.gaps.some((g) => /could not be read \(unknown command\)/.test(g)));
  assert.equal(noCurrency.worksets.length, 4); // workset ownership still reported
  const plain = buildOwnersReport(normalizeOwnersFacts({ workshared: false, user: "ANN" })!, null, [], [], {});
  assert.equal(plain.worksets.length, 0);
  assert.ok(plain.gaps[0].includes("not workshared"));
});

// ---- the tool -------------------------------------------------------------------------------------------------

function toolArgs(over: Partial<FmcWorkshareOwnersArgs> = {}): FmcWorkshareOwnersArgs {
  const defaults = Object.fromEntries(Object.entries(FMC_WORKSHARE_OWNERS_SHAPE).map(([k, v]) => [k, (v as { parse(x: unknown): unknown }).parse(undefined)]));
  return { ...(defaults as FmcWorkshareOwnersArgs), ...over };
}
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
const factsRaw = { model: "M.rvt", workshared: true, user: "ANN", central: "C:\\c.rvt", worksets: [ws(1, "A_Shell", "ANN"), ws(2, "A_Interior", "BOB")] };

function fakeRevit(over: { currency?: unknown; fail?: boolean } = {}) {
  const sent: { command: string; params: Record<string, unknown> }[] = [];
  const send = async (command: string, params: Record<string, unknown>) => {
    sent.push({ command, params });
    if (command === "fmc_workshare_facts") return factsRaw;
    if (over.fail) throw new Error("Unknown command fmc_elem_currency");
    return over.currency ?? { elements: ROWS };
  };
  return { sent, send: send as never };
}

test("the tool sends only the two read commands, names the ids once, and reports blocked ops", async () => {
  const { sent, send } = fakeRevit();
  const out = body(await runFmcWorkshareOwners(toolArgs({
    element_ids: [10, "12"],
    planned_ops: [{ label: "move walls", params: { ids: [10, 11] } }, { label: "tag", params: { element_ids: ["12"], workset: "A_Interior" } }],
  }), { send }));
  assert.deepEqual([...new Set(sent.map((s) => s.command))].sort(), [...OWNERS_COMMANDS].sort());
  assert.equal(sent.filter((s) => s.command === "fmc_elem_currency").length, 1);
  assert.deepEqual(sent.find((s) => s.command === "fmc_elem_currency")?.params, { ids: ["10", "12", "11"] });
  assert.equal(out.read_only, true);
  assert.equal(out.user, "ANN");
  assert.deepEqual(out.planned_ops.map((o: { verdict: string }) => o.verdict), ["partly_blocked", "partly_blocked"]);
  assert.equal(out.planned_ops[1].blocked_worksets[0].owner, "BOB");
  assert.equal(out.elements.find((e: { id: string }) => e.id === "10").code, OWNED_BY_OTHER);
});

test("the tool degrades when the add-in has no element ownership, and with no ids asks nothing", async () => {
  const noEl = fakeRevit({ fail: true });
  const out = body(await runFmcWorkshareOwners(toolArgs({ element_ids: ["10"] }), { send: noEl.send }));
  assert.equal(out.elements[0].can_edit, null);
  assert.ok(out.gaps.some((g: string) => /Unknown command fmc_elem_currency/.test(g)));
  assert.equal(out.worksets.length, 2);
  const none = fakeRevit();
  const bare = body(await runFmcWorkshareOwners(toolArgs(), { send: none.send }));
  assert.deepEqual(none.sent.map((s) => s.command), ["fmc_workshare_facts"]);
  assert.equal(bare.elements.length, 0);
  const lots = fakeRevit();
  const big = body(await runFmcWorkshareOwners(toolArgs({ element_ids: Array.from({ length: MAX_ELEMENT_IDS + 7 }, (_, i) => i + 1) }), { send: lots.send }));
  assert.equal((lots.sent[1].params.ids as string[]).length, MAX_ELEMENT_IDS);
  assert.ok(big.gaps.some((g: string) => /7 element id\(s\) over the limit/.test(g)));
});

test("the tool is refused plainly when Revit gives nothing", async () => {
  const r = await runFmcWorkshareOwners(toolArgs(), { send: (async () => null) as never });
  assert.equal(r.isError, true);
  assert.match(body(r).reasons[0], /no workshare facts/);
  const down = await runFmcWorkshareOwners(toolArgs(), { send: (async () => { throw new Error("no Revit"); }) as never });
  assert.equal(down.isError, true);
});

test("fmc_workshare_owners registers as one read-only tool", () => {
  const seen: { name: string; description: string }[] = [];
  registerFmcWorkshareOwnersTool({ tool: (name: string, description: string) => { seen.push({ name, description }); } } as unknown as McpServer);
  assert.deepEqual(seen.map((s) => s.name), ["fmc_workshare_owners"]);
  assert.match(seen[0].description, /never relinquishes, synchronises, saves or checks anything out/);
  assert.match(seen[0].description, /fmc_workshare_facts and fmc_elem_currency/);
});
