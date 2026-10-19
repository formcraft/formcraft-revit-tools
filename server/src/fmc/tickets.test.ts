import { test } from "node:test";
import assert from "node:assert/strict";
import { Register } from "./review.js";
import { AI_OWNER, applyBcf, clashTickets, comment, mark, markProblems, queue, roleOfModel, take, titleFrom } from "./tickets.js";
import { fromBcf, toBcf } from "./bcf.js";
import { crc32, readZip, writeZip } from "./zip.js";

const now = new Date("2026-10-19T09:00:00Z");
const reg = (): Register => ({ project: "F26001", items: [] });
const door = { unique_ids: ["a1b2c3d4-0001-0002-0003-000000045678-0005e0f1"], view: "L2 - ICU", point_mm: [12500, 4300, 1050] };

test("zip: what is written reads back the same, deflated or stored; CRC is the standard one", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const z = writeZip([{ name: "a/markup.bcf", data: "<Markup>" + "x".repeat(500) + "</Markup>" }, { name: "a/snapshot.png", data: png }]);
  const back = readZip(z);
  assert.equal(back.get("a/markup.bcf")!.toString(), "<Markup>" + "x".repeat(500) + "</Markup>");
  assert.deepEqual(back.get("a/snapshot.png"), png);
});

test("Mark & Review: a mark needs words and a place; a ticket for the AI is owned by the AI modeller", () => {
  assert.deepEqual(markProblems({ to: "person", priority: "High", raised_by: "Owner", model: "", where: { unique_ids: [] } }, "2026-10-19"),
    ["Say what is wrong: a note or a voice note", "Mark something: an element, or a point in the model", "Name the person it is for"]);
  const r = reg();
  const t = mark(r, { to: "ai", text: "The door should be 1026 wide. The frame clashes with the column.", priority: "High", raised_by: "Owner", model: "F26001-ARC", where: door }, now);
  assert.equal(t.id, "F26001-ISS-0001");
  assert.equal(t.owner, AI_OWNER);
  assert.equal(t.title, "The door should be 1026 wide.", "the first sentence becomes the title");
  assert.equal(t.due, "2026-10-26", "High: one week (MAN 10.5)");
  assert.equal(t.notes![0].text, "The door should be 1026 wide. The frame clashes with the column.");
  assert.equal(titleFrom(""), "Voice note");
});

test("Mark & Review: the queue is most urgent first; anyone can take an open ticket; the thread takes typed or spoken replies", () => {
  const r = reg();
  const a = mark(r, { to: "ai", text: "Ceiling too low over the bed", priority: "Medium", raised_by: "Owner", model: "", where: door }, now);
  const b = mark(r, { to: "ai", text: "Missing O2 outlet", priority: "Critical", raised_by: "Owner", model: "", where: door }, now);
  const c = mark(r, { to: "anyone", text: "Check the swing", priority: "Low", raised_by: "Owner", model: "", where: door }, now);
  mark(r, { to: "discipline", assignee: "E", text: "Socket clear of the bedhead", priority: "High", raised_by: "Owner", model: "", where: door }, now);
  assert.deepEqual(queue(r, { ai: true }).map((i) => i.id), [b.id, a.id]);
  assert.deepEqual(queue(r, { discipline: "E" }).map((i) => i.lead), ["E"]);
  take(c, "Jane", now);
  assert.equal(c.owner, "Jane");
  assert.equal(c.status, "In progress");
  assert.throws(() => take(a, "Jane", now), /for the AI modeller/);
  comment(a, { by: "Owner", text: "", audio: "media/F26001-ISS-0001/note-2.opus", transcript: "raise it to 2900" }, now);
  assert.equal(a.notes!.length, 2);
  assert.equal(a.notes![1].audio, "media/F26001-ISS-0001/note-2.opus");
});

test("BCF: tickets go out as BCF 2.1 and come back as the same tickets, with their place, thread and snapshot", () => {
  const r = reg();
  const t = mark(r, { to: "ai", text: "Frame clashes with the column", priority: "Critical", raised_by: "Owner", model: "",
    where: { ...door, camera: { eye: [10000, 2000, 3000], direction: [0.6, 0.6, -0.5], up: [0, 0, 1], perspective: true, field_of_view: 50 },
      section_box: { min: [11000, 3000, 0], max: [14000, 5600, 3000] } } }, now);
  comment(t, { by: "Jane (E)", text: "Column is structural: move the door 200 to the left" }, now);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
  const { zip, guids } = toBcf([t], () => png, "F26001");
  const files = readZip(zip);
  assert.ok(files.has("bcf.version") && files.has(`${guids.get(t.id)}/markup.bcf`) && files.has(`${guids.get(t.id)}/viewpoint.bcfv`));
  const [topic] = fromBcf(zip);
  assert.equal(topic.title, "Frame clashes with the column");
  assert.equal(topic.status, "Open");
  assert.equal(topic.priority, "Critical");
  assert.deepEqual(topic.where.unique_ids, door.unique_ids, "the elements by their Revit UniqueId");
  assert.deepEqual(topic.where.camera!.eye, [10000, 2000, 3000], "metres in BCF, millimetres back");
  assert.equal(topic.where.camera!.field_of_view, 50);
  assert.deepEqual(topic.comments.map((c) => c.by), ["Owner", "Jane (E)"]);
  assert.deepEqual(topic.snapshot, png);
  // into a register that already has it: the same ticket, with only the new reply added
  t.guid = guids.get(t.id);
  const reply = toBcf([{ ...t, notes: [...t.notes!, { at: "2026-10-20T08:00:00Z", by: "Consultant", text: "Agreed" }], status: "Resolved" }], () => null, "F26001").zip;
  const res = applyBcf(r, fromBcf(reply), now, () => undefined);
  assert.deepEqual(res, { added: [], updated: [t.id] });
  assert.equal(t.notes!.length, 3);
  assert.equal(t.status, "Resolved");
});

test("BCF: a topic from another tool (IFC GUIDs, no Formcraft ids) becomes a new ticket for anyone", () => {
  const markup = `<?xml version="1.0" encoding="UTF-8"?><Markup><Topic Guid="0d4c5c1e-1111-4222-8333-444455556666" TopicType="Issue" TopicStatus="Open">
    <Title>Duct through beam</Title><Priority>High</Priority><Labels>M</Labels><CreationDate>2026-10-18T10:00:00Z</CreationDate>
    <CreationAuthor>solibri@consultant</CreationAuthor><Description>Duct passes through the beam at grid C/4</Description></Topic>
    <Comment Guid="c1"><Date>2026-10-18T10:00:00Z</Date><Author>solibri@consultant</Author><Comment>Please reroute</Comment></Comment>
    <Viewpoints Guid="v1"><Viewpoint>viewpoint.bcfv</Viewpoint></Viewpoints></Markup>`;
  const vp = `<VisualizationInfo Guid="v1"><Components><Selection><Component IfcGuid="2O2Fr$t4X7Zf8NOew3FLOH"/></Selection></Components>
    <PerspectiveCamera><CameraViewPoint><X>12.5</X><Y>4.3</Y><Z>3.0</Z></CameraViewPoint><CameraDirection><X>0</X><Y>1</Y><Z>0</Z></CameraDirection>
    <CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector><FieldOfView>60</FieldOfView></PerspectiveCamera></VisualizationInfo>`;
  const zip = writeZip([{ name: "0d4c5c1e-1111-4222-8333-444455556666/markup.bcf", data: markup }, { name: "0d4c5c1e-1111-4222-8333-444455556666/viewpoint.bcfv", data: vp }]);
  const r = reg();
  const res = applyBcf(r, fromBcf(zip), now, () => undefined);
  assert.equal(res.added.length, 1);
  const t = r.items[0];
  assert.equal(t.to, "anyone");
  assert.equal(t.lead, "M");
  assert.equal(t.source, "bcf");
  assert.deepEqual(t.where!.ifc_guids, ["2O2Fr$t4X7Zf8NOew3FLOH"]);
  assert.deepEqual(t.where!.camera!.eye, [12500, 4300, 3000]);
  assert.equal(t.notes![0].text, "Please reroute");
});

test("R5: Navisworks clashes become tickets for the clashing disciplines, deepest first, never twice", () => {
  assert.equal(roleOfModel("D:\P\F26001-FMC-ZZ-02-M3-M-0001.rvt"), "M");
  assert.equal(roleOfModel("Central.rvt"), "BIM");
  const r = reg();
  const row = (name: string, d: number, status = "New") => ({ name, status, distance_mm: d, center_mm: [12000, 4000, 2900],
    item1: { name: "Duct", category: "Ducts", revit_id: "412233", source: "F26001-FMC-ZZ-02-M3-M-0001.rvt" },
    item2: { name: "Beam", category: "Structural Framing", revit_id: "998877", source: "F26001-FMC-ZZ-02-M3-S-0001.rvt" } });
  const first = clashTickets(r, "M vs S", [row("Clash1", -80), row("Clash2", -10), row("Clash3", -40, "Resolved")], "Coordinator", now);
  assert.equal(first.added.length, 2);
  assert.equal(first.skipped, 1, "a resolved clash isn't ticketed");
  const t = r.items[0];
  assert.equal(t.lead, "M");
  assert.deepEqual(t.disciplines, ["M", "S"]);
  assert.equal(t.priority, "High", "80 mm deep");
  assert.equal(r.items[1].priority, "Medium");
  assert.equal(t.source, "clash");
  assert.deepEqual(t.links!.clash!.items!.map((x) => x.id), ["412233", "998877"]);
  assert.deepEqual(t.where!.point_mm, [12000, 4000, 2900]);
  assert.deepEqual(clashTickets(r, "M vs S", [row("Clash1", -80)], "Coordinator", now), { added: [], skipped: 1 }, "never twice");
});
