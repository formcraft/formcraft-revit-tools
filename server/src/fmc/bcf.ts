/**
 * BCF 2.1 (buildingSMART's BIM Collaboration Format) for Mark & Review tickets (docs/PLAN_MARK_REVIEW.md, R1): the
 * markup format Navisworks, Solibri, BIMcollab and Autodesk Construction Cloud read and write, so people without the
 * plugin can see, answer and send tickets. A ticket is a topic: its thread as comments, its place as a viewpoint
 * (the selected elements, the camera, the section box as clipping planes, in metres) and its picture as the snapshot.
 * Pure apart from the pictures, which the caller reads and writes.
 */
import crypto from "node:crypto";
import { Note, ReviewItem, Where } from "./review.js";
import { readZip, writeZip } from "./zip.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const m = (v: number) => (v / 1000).toFixed(6);
const mm = (v: string) => Math.round(Number(v) * 1000 * 100) / 100;

/** BCF topic status from the register's, and back. */
const TO_BCF: Record<ReviewItem["status"], string> = { Open: "Open", "In progress": "Active", Resolved: "Resolved", Closed: "Closed" };
const FROM_BCF = (s: string): ReviewItem["status"] => /^closed$/i.test(s) ? "Closed" : /^resolved$/i.test(s) ? "Resolved" : /^(active|in ?progress)$/i.test(s) ? "In progress" : "Open";

export const guidFor = (seed: string) => {
  const h = crypto.createHash("sha1").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const xyz = (tag: string, v: number[], scale = true) => `<${tag}><X>${scale ? m(v[0]) : v[0]}</X><Y>${scale ? m(v[1]) : v[1]}</Y><Z>${scale ? m(v[2]) : v[2]}</Z></${tag}>`;

function viewpointXml(guid: string, w: Where): string {
  const comps = [...w.unique_ids.map((u, k) => ({ ifc: w.ifc_guids?.[k] ?? "", id: u })), ...(w.linked ?? []).map((l) => ({ ifc: "", id: l.unique_id }))];
  const sel = comps.length ? `<Components><Selection>${comps.map((c) => `<Component${c.ifc ? ` IfcGuid="${esc(c.ifc)}"` : ""}><OriginatingSystem>Formcraft (Revit)</OriginatingSystem><AuthoringToolId>${esc(c.id)}</AuthoringToolId></Component>`).join("")}</Selection></Components>` : "";
  let cam = "";
  if (w.camera) {
    const c = w.camera;
    cam = c.perspective
      ? `<PerspectiveCamera>${xyz("CameraViewPoint", c.eye)}${xyz("CameraDirection", c.direction, false)}${xyz("CameraUpVector", c.up, false)}<FieldOfView>${c.field_of_view ?? 60}</FieldOfView></PerspectiveCamera>`
      : `<OrthogonalCamera>${xyz("CameraViewPoint", c.eye)}${xyz("CameraDirection", c.direction, false)}${xyz("CameraUpVector", c.up, false)}<ViewToWorldScale>${((c.scale ?? 10000) / 1000).toFixed(3)}</ViewToWorldScale></OrthogonalCamera>`;
  } else if (w.point_mm) {
    // a mark on a point with no camera: look at it from above-front, 5 m away
    const p = w.point_mm;
    cam = `<PerspectiveCamera>${xyz("CameraViewPoint", [p[0] - 3000, p[1] - 3000, p[2] + 2500])}${xyz("CameraDirection", [0.6, 0.6, -0.5], false)}${xyz("CameraUpVector", [0, 0, 1], false)}<FieldOfView>60</FieldOfView></PerspectiveCamera>`;
  }
  let clip = "";
  if (w.section_box) {
    const { min, max } = w.section_box;
    // six planes facing out of the box (BCF: the part on the direction side is cut away)
    const planes: Array<[number[], number[]]> = [
      [[min[0], 0, 0], [-1, 0, 0]], [[max[0], 0, 0], [1, 0, 0]], [[0, min[1], 0], [0, -1, 0]],
      [[0, max[1], 0], [0, 1, 0]], [[0, 0, min[2]], [0, 0, -1]], [[0, 0, max[2]], [0, 0, 1]],
    ];
    clip = `<ClippingPlanes>${planes.map(([loc, dir]) => `<ClippingPlane>${xyz("Location", loc)}${xyz("Direction", dir, false)}</ClippingPlane>`).join("")}</ClippingPlanes>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<VisualizationInfo Guid="${guid}">${sel}${cam}${clip}</VisualizationInfo>\n`;
}

function markupXml(i: ReviewItem, topic: string, vp: string, hasSnapshot: boolean): string {
  const notes: Note[] = i.notes?.length ? i.notes : [{ at: i.raised_at, by: i.raised_by, text: i.description }];
  const comments = notes.map((n, k) => `<Comment Guid="${guidFor(`${topic}/c${k}`)}"><Date>${esc(n.at)}</Date><Author>${esc(n.by)}</Author><Comment>${esc(n.text || n.transcript || (n.audio ? "(voice note)" : ""))}</Comment><Viewpoint Guid="${vp}"/></Comment>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Markup><Topic Guid="${topic}" TopicType="${i.source === "clash" ? "Clash" : "Issue"}" TopicStatus="${TO_BCF[i.status]}">`
    + `<Title>${esc(i.title)}</Title><Priority>${esc(i.priority)}</Priority><Index>${esc(i.id)}</Index>`
    + i.disciplines.map((d) => `<Labels>${esc(d)}</Labels>`).join("")
    + `<CreationDate>${esc(i.raised_at)}</CreationDate><CreationAuthor>${esc(i.raised_by)}</CreationAuthor>`
    + `<AssignedTo>${esc(i.owner)}</AssignedTo><DueDate>${esc(i.due)}T17:00:00Z</DueDate><Description>${esc(i.description)}</Description></Topic>`
    + comments
    + `<Viewpoints Guid="${vp}"><Viewpoint>viewpoint.bcfv</Viewpoint>${hasSnapshot ? "<Snapshot>snapshot.png</Snapshot>" : ""}</Viewpoints></Markup>\n`;
}

/** A .bcfzip of these tickets. `picture` gives a ticket's snapshot (PNG bytes) when it has one. */
export function toBcf(items: ReviewItem[], picture: (i: ReviewItem) => Buffer | null, projectName = ""): { zip: Buffer; guids: Map<string, string> } {
  const entries: Array<{ name: string; data: Buffer | string }> = [
    { name: "bcf.version", data: `<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>\n` },
  ];
  if (projectName) entries.push({ name: "project.bcfp", data: `<?xml version="1.0" encoding="UTF-8"?>\n<ProjectExtension><Project ProjectId="${guidFor(projectName)}"><Name>${esc(projectName)}</Name></Project></ProjectExtension>\n` });
  const guids = new Map<string, string>();
  for (const i of items) {
    const topic = i.guid ?? guidFor(`${projectName}/${i.id}`);
    guids.set(i.id, topic);
    const vp = guidFor(`${topic}/viewpoint`);
    const png = picture(i);
    entries.push({ name: `${topic}/markup.bcf`, data: markupXml(i, topic, vp, !!png) });
    entries.push({ name: `${topic}/viewpoint.bcfv`, data: viewpointXml(vp, i.where ?? { unique_ids: [] }) });
    if (png) entries.push({ name: `${topic}/snapshot.png`, data: png });
  }
  return { zip: writeZip(entries), guids };
}

export interface BcfTopic {
  guid: string; title: string; status: ReviewItem["status"]; priority: string; author: string; created: string; assigned: string;
  due: string; description: string; labels: string[]; type: string;
  comments: Array<{ at: string; by: string; text: string }>;
  where: Where; snapshot: Buffer | null;
}

// an element's text; a self-closing one (<Viewpoint Guid="…"/> in a comment) is skipped, never read as an open tag
const tag = (xml: string, t: string) => { const r = new RegExp(`<${t}(?:\\s[^>]*[^/])?>([\\s\\S]*?)</${t}>`).exec(xml); return r ? unesc(r[1].trim()) : ""; };
const attr = (xml: string, t: string, a: string) => new RegExp(`<${t}\\b[^>]*\\b${a}="([^"]*)"`).exec(xml)?.[1] ?? "";
const vec = (xml: string, t: string, scale: boolean) => { const b = tag(xml, t); return b ? ["X", "Y", "Z"].map((k) => (scale ? mm(tag(b, k)) : Number(tag(b, k)))) : undefined; };

/** The topics of a .bcfzip (2.0, 2.1 or 3.0 markups), each with its place and snapshot. */
export function fromBcf(buf: Buffer): BcfTopic[] {
  const files = readZip(buf);
  const topics: BcfTopic[] = [];
  for (const [name, data] of files) {
    if (!/(^|\/)markup\.bcf$/i.test(name)) continue;
    const dir = name.replace(/markup\.bcf$/i, "");
    const xml = data.toString("utf8");
    const t = /<Topic\b[\s\S]*?<\/Topic>/.exec(xml)?.[0] ?? "";
    const comments = [...xml.matchAll(/<Comment\b[^>]*>([\s\S]*?)<\/Comment>(?=\s*(<Comment\b|<Viewpoints|<\/Markup|<\/Comments))/g)].map((c) => ({
      at: tag(c[1], "Date"), by: tag(c[1], "Author"), text: tag(c[1].replace(/<Viewpoint[^>]*\/>/g, ""), "Comment"),
    })).filter((c) => c.text || c.by);
    const vpName = tag(xml, "Viewpoint") || "viewpoint.bcfv";
    const vpXml = files.get(dir + vpName)?.toString("utf8") ?? "";
    const comps = [...vpXml.matchAll(/<Component\b([^>]*)>([\s\S]*?)<\/Component>|<Component\b([^>]*)\/>/g)].map((c) => ({
      ifc: /IfcGuid="([^"]*)"/.exec(c[1] ?? c[3] ?? "")?.[1] ?? "", id: c[2] ? tag(c[2], "AuthoringToolId") : "",
    }));
    const where: Where = { unique_ids: comps.map((c) => c.id).filter(Boolean), ifc_guids: comps.map((c) => c.ifc).filter(Boolean) };
    const camXml = /<PerspectiveCamera>[\s\S]*?<\/PerspectiveCamera>/.exec(vpXml)?.[0] ?? /<OrthogonalCamera>[\s\S]*?<\/OrthogonalCamera>/.exec(vpXml)?.[0];
    if (camXml) where.camera = { eye: vec(camXml, "CameraViewPoint", true) ?? [0, 0, 0], direction: vec(camXml, "CameraDirection", false) ?? [0, 1, 0],
      up: vec(camXml, "CameraUpVector", false) ?? [0, 0, 1], perspective: camXml.startsWith("<Perspective"),
      ...(camXml.startsWith("<Perspective") ? { field_of_view: Number(tag(camXml, "FieldOfView") || 60) } : { scale: Number(tag(camXml, "ViewToWorldScale") || 10) * 1000 }) };
    const snapName = tag(xml, "Snapshot");
    topics.push({
      guid: attr(t, "Topic", "Guid"), title: tag(t, "Title") || "(no title)", status: FROM_BCF(attr(t, "Topic", "TopicStatus")), type: attr(t, "Topic", "TopicType"),
      priority: tag(t, "Priority"), author: tag(t, "CreationAuthor"), created: tag(t, "CreationDate"), assigned: tag(t, "AssignedTo"),
      due: tag(t, "DueDate").slice(0, 10), description: tag(t, "Description"), labels: [...t.matchAll(/<Labels>([\s\S]*?)<\/Labels>/g)].map((x) => unesc(x[1].trim())),
      comments, where, snapshot: snapName ? files.get(dir + snapName) ?? null : null,
    });
  }
  return topics;
}
