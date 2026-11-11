/**
 * Server-side fixture connect. Today's add-in refuses a basin or a WC ("isn't a duct, pipe, tray or conduit").
 * This builds one fixed script and runs it through send_code_to_revit, which is a write: the batch lease,
 * the live-model lock, and the keynote and reference checks on that write still apply. The add-in's auto
 * transaction is the one transaction; a throw rolls it back.
 */
import { screenScript } from "./scriptguard.js";

export const TIE_MM = 1;

/** Basin and WC services this connect covers. */
export const FIXTURE_CASES = [
  { fixture: "basin", service: "waste", systems: ["Sanitary"] },
  { fixture: "basin", service: "hot supply", systems: ["DomesticHotWater"] },
  { fixture: "basin", service: "cold supply", systems: ["DomesticColdWater"] },
  { fixture: "basin", service: "supply", systems: ["DomesticHotWater", "DomesticColdWater"] },
  { fixture: "WC", service: "soil", systems: ["Sanitary"] },
  { fixture: "WC", service: "cold supply", systems: ["DomesticColdWater"] },
] as const;

export interface ConnectorFact {
  system: string;
  /** Distance from this fixture connector to the pipe's nearest open end, in millimetres. */
  distanceMm: number;
  connected?: boolean;
  domain?: "piping" | "hvac" | "other";
}

export type SystemChoice =
  | { accept: string[]; infer: false }
  | { accept: null; infer: true }
  | { error: string };

const FIX = "Fix: pass system as sanitary (waste or soil), domestic cold (supply), or domestic hot (supply).";

/** Maps the caller's words onto piping system classifications. Omitted means the pipe's own classification. */
export function systemChoice(system: string | undefined): SystemChoice {
  if (system == null || system.trim() === "") return { accept: null, infer: true };
  const s = system.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (s === "sanitary" || s === "waste" || s === "soil") return { accept: ["Sanitary"], infer: false };
  if (s === "supply") return { accept: ["DomesticHotWater", "DomesticColdWater"], infer: false };
  if (s === "domestic hot" || s === "domestic hot water" || s === "hot" || s === "dhw" || s === "hot supply" || s === "supply hot") return { accept: ["DomesticHotWater"], infer: false };
  if (s === "domestic cold" || s === "domestic cold water" || s === "cold" || s === "dcw" || s === "cold supply" || s === "supply cold") return { accept: ["DomesticColdWater"], infer: false };
  return { error: `[FMC-CONNECT] Unknown system "${system}". ${FIX}` };
}

/**
 * The same choice the script makes once the fixture's connectors are known.
 * A tie within 1 mm is ambiguous and is refused with a fix hint. Nothing is connected.
 */
export function chooseFixtureConnector(connectors: ConnectorFact[], accept: string[]): { index: number; system: string } | { error: string } {
  const open = connectors
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c.domain !== "hvac" && c.domain !== "other" && !c.connected && accept.includes(c.system));
  if (open.length === 0) {
    return { error: `[FMC-CONNECT] The fixture has no unconnected piping connector for ${accept.join(" or ")}. ${FIX} A basin has sanitary waste plus domestic hot and cold. A WC has sanitary soil plus domestic cold.` };
  }
  const ranked = [...open].sort((a, b) => a.distanceMm - b.distanceMm);
  if (ranked.length >= 2 && Math.abs(ranked[0].distanceMm - ranked[1].distanceMm) <= TIE_MM) {
    return { error: `[FMC-CONNECT] ${ranked.length} compatible unconnected connectors are the same distance apart. ${FIX}` };
  }
  return { index: ranked[0].index, system: ranked[0].system };
}

function elementId(value: number | string, name: string): string {
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`[FMC-CONNECT] ${name} must be an element id (an integer). Fix: pass the id from the model, not a name.`);
  }
  return text;
}

export interface FixtureConnectArgs {
  document: string;
  pipe: number | string;
  fixture: number | string;
  system?: string;
}

export interface FixtureConnectCall {
  command: "send_code_to_revit";
  params: {
    code: string;
    parameters: string[];
    usings: string[];
    transactionMode: "auto";
    purpose: string;
    document: string;
  };
}

/** The fixed script, plus the send_code_to_revit call. Refuses a bad id or system before anything is sent. */
export function fixtureConnectCall(args: FixtureConnectArgs): FixtureConnectCall {
  const document = args.document?.trim() ?? "";
  if (!document) throw new Error("[FMC-CONNECT] document is required (the open model's title or full path). Fix: pass the document this pipe and fixture are in.");
  const pipe = elementId(args.pipe, "pipe");
  const fixture = elementId(args.fixture, "fixture");
  const choice = systemChoice(args.system);
  if ("error" in choice) throw new Error(choice.error);
  const accept = choice.infer ? "new string[0]" : `new string[] { ${choice.accept.map((name) => `"${name}"`).join(", ")} }`;
  const code = FIXTURE_SCRIPT
    .replace("PIPE_ID", `${pipe}L`)
    .replace("FIXTURE_ID", `${fixture}L`)
    .replace("ACCEPT_LIST", accept)
    .replace("INFER_SYSTEM", choice.infer ? "true" : "false");
  const problem = screenScript(code);
  if (problem) throw new Error(problem.message);
  return {
    command: "send_code_to_revit",
    params: {
      code,
      parameters: [],
      usings: ["Autodesk.Revit.DB.Plumbing"],
      transactionMode: "auto",
      purpose: "Connect a pipe end to a plumbing fixture",
      document,
    },
  };
}

/**
 * Body of Execute(Document document, object[] parameters). No transaction of its own: send_code_to_revit
 * mode auto already wraps this in one transaction and rolls it back when this throws.
 * PIPE_ID, FIXTURE_ID, ACCEPT_LIST and INFER_SYSTEM are filled from checked values, never from raw text.
 */
const FIXTURE_SCRIPT = `
long pipeId = PIPE_ID;
long fixtureId = FIXTURE_ID;
string[] accept = ACCEPT_LIST;
bool infer = INFER_SYSTEM;
const double tol = 1.0 / 304.8;
Element pipeEl = document.GetElement(new ElementId(pipeId));
Element fixEl = document.GetElement(new ElementId(fixtureId));
if (pipeEl == null) throw new InvalidOperationException("[FMC-CONNECT] No element " + pipeId + ". Fix: pass the pipe's element id.");
if (fixEl == null) throw new InvalidOperationException("[FMC-CONNECT] No element " + fixtureId + ". Fix: pass the fixture's element id.");
FamilyInstance fixture = fixEl as FamilyInstance;
ConnectorManager fixtureCm = fixture == null ? null : fixture.MEPModel == null ? null : fixture.MEPModel.ConnectorManager;
if (fixtureCm == null) throw new InvalidOperationException("[FMC-CONNECT] " + fixtureId + " has no MEP connectors. Fix: pass a plumbing fixture (a basin or a WC), not a duct, pipe, tray or conduit.");
var fixtureEnds = new List<Connector>();
foreach (Connector c in fixtureCm.Connectors)
{
    if (c.ConnectorType != ConnectorType.End || c.Domain != Domain.DomainPiping) continue;
    try { if (c.IsConnected) continue; } catch (InvalidOperationException) { continue; }
    fixtureEnds.Add(c);
}
Pipe source = pipeEl as Pipe;
ConnectorManager pipeCm = source != null ? source.ConnectorManager : (pipeEl as FamilyInstance) == null ? null : (pipeEl as FamilyInstance).MEPModel == null ? null : (pipeEl as FamilyInstance).MEPModel.ConnectorManager;
if (pipeCm == null) throw new InvalidOperationException("[FMC-CONNECT] " + pipeId + " is not a pipe or a pipe end. Fix: pass the pipe element id.");
if (source == null)
{
    foreach (Connector c in pipeCm.Connectors)
    {
        try { if (!c.IsConnected) continue; } catch (InvalidOperationException) { continue; }
        foreach (Connector r in c.AllRefs)
        {
            Pipe owner = r.Owner as Pipe;
            if (owner != null && owner.Id != pipeEl.Id) source = owner;
        }
    }
}
var pipeEnds = new List<Connector>();
foreach (Connector c in pipeCm.Connectors)
{
    if (c.ConnectorType != ConnectorType.End || c.Domain != Domain.DomainPiping) continue;
    try { if (c.IsConnected) continue; } catch (InvalidOperationException) { continue; }
    pipeEnds.Add(c);
}
if (pipeEnds.Count == 0) throw new InvalidOperationException("[FMC-CONNECT] " + pipeId + " has no open piping end. Fix: pass the open pipe, not one that is already connected at both ends.");
if (infer)
{
    string pipeClass = "";
    try { pipeClass = pipeEnds[0].PipeSystemType.ToString(); } catch (Exception) { pipeClass = ""; }
    if (pipeClass == "Sanitary" || pipeClass == "DomesticHotWater" || pipeClass == "DomesticColdWater") accept = new string[] { pipeClass };
    else throw new InvalidOperationException("[FMC-CONNECT] The pipe system is " + (pipeClass.Length == 0 ? "unset" : pipeClass) + ". The fixture connector is ambiguous. Fix: pass system as sanitary (waste or soil), domestic cold (supply), or domestic hot (supply).");
}
var matches = new List<Connector>();
foreach (Connector c in fixtureEnds)
{
    string cls = "";
    try { cls = c.PipeSystemType.ToString(); } catch (Exception) { cls = ""; }
    foreach (string name in accept) if (cls == name) matches.Add(c);
}
if (matches.Count == 0) throw new InvalidOperationException("[FMC-CONNECT] " + fixtureId + " has no unconnected piping connector for " + string.Join(" or ", accept) + ". Fix: a basin has sanitary waste plus domestic hot and cold; a WC has sanitary soil plus domestic cold. Pass system to name which one.");
var ranked = new List<Tuple<Connector, Connector, double>>();
foreach (Connector f in matches)
{
    Connector end = null;
    double d = double.MaxValue;
    foreach (Connector p in pipeEnds)
    {
        double dd = f.Origin.DistanceTo(p.Origin);
        if (dd < d) { d = dd; end = p; }
    }
    ranked.Add(Tuple.Create(f, end, d));
}
Tuple<Connector, Connector, double> first = null;
Tuple<Connector, Connector, double> second = null;
foreach (Tuple<Connector, Connector, double> row in ranked)
{
    if (first == null || row.Item3 < first.Item3) { second = first; first = row; }
    else if (second == null || row.Item3 < second.Item3) second = row;
}
if (second != null && System.Math.Abs(first.Item3 - second.Item3) <= tol) throw new InvalidOperationException("[FMC-CONNECT] " + fixtureId + " has " + matches.Count + " compatible unconnected connectors and the nearest two are the same distance. Fix: pass system as sanitary, domestic hot, or domestic cold so only one connector matches.");
Connector bestFix = first.Item1;
Connector bestPipe = first.Item2;
double best = first.Item3;
string how;
long made = 0;
if (best <= tol)
{
    bestPipe.ConnectTo(bestFix);
    how = "connect_to";
}
else
{
    if (source == null) throw new InvalidOperationException("[FMC-CONNECT] The connectors are " + System.Math.Round(best * 304.8, 1) + " mm apart and " + pipeId + " is not a pipe, so a connecting pipe cannot be created. Fix: pass the pipe element id.");
    ElementId levelId = source.ReferenceLevel != null ? source.ReferenceLevel.Id : (source.get_Parameter(BuiltInParameter.RBS_START_LEVEL_PARAM) == null ? ElementId.InvalidElementId : source.get_Parameter(BuiltInParameter.RBS_START_LEVEL_PARAM).AsElementId());
    ElementId sysId = source.get_Parameter(BuiltInParameter.RBS_PIPING_SYSTEM_TYPE_PARAM) == null ? ElementId.InvalidElementId : source.get_Parameter(BuiltInParameter.RBS_PIPING_SYSTEM_TYPE_PARAM).AsElementId();
    if (levelId == ElementId.InvalidElementId) throw new InvalidOperationException("[FMC-CONNECT] Pipe " + source.Id.Value + " has no level. Fix: set the pipe's reference level, then connect again.");
    if (sysId == ElementId.InvalidElementId) throw new InvalidOperationException("[FMC-CONNECT] Pipe " + source.Id.Value + " has no piping system type. Fix: set the pipe's system (sanitary, domestic cold, or domestic hot), then connect again.");
    Pipe link;
    try { link = Pipe.Create(document, sysId, source.PipeType.Id, levelId, bestPipe.Origin, bestFix.Origin); }
    catch (Exception ex) { throw new InvalidOperationException("[FMC-CONNECT] The connectors are " + System.Math.Round(best * 304.8, 1) + " mm apart and Revit did not create the connecting pipe (" + ex.Message + "). Fix: move the pipe end onto the fixture connector, or leave a longer gap, then connect again."); }
    made = link.Id.Value;
    try
    {
        Parameter fromKey = source.get_Parameter(BuiltInParameter.KEYNOTE_PARAM);
        Parameter toKey = link.get_Parameter(BuiltInParameter.KEYNOTE_PARAM);
        if (fromKey != null && toKey != null && !toKey.IsReadOnly && fromKey.HasValue) toKey.Set(fromKey.AsString() ?? "");
    }
    catch (Exception) { /* the pipe's keynote stays on the type when the instance has none */ }
    Connector linkPipe = null;
    Connector linkFix = null;
    foreach (Connector c in link.ConnectorManager.Connectors)
    {
        if (c.Origin.DistanceTo(bestPipe.Origin) <= tol) linkPipe = c;
        if (c.Origin.DistanceTo(bestFix.Origin) <= tol) linkFix = c;
    }
    if (linkPipe == null || linkFix == null) throw new InvalidOperationException("[FMC-CONNECT] The new pipe's ends did not land on the open connectors. Nothing is kept: this error rolls the transaction back.");
    linkPipe.ConnectTo(bestPipe);
    linkFix.ConnectTo(bestFix);
    how = "pipe";
}
string joined = "";
try { joined = bestFix.PipeSystemType.ToString(); } catch (Exception) { joined = ""; }
return new { title = document.Title, path = document.PathName ?? "", fixture = fixtureId, pipe = pipeId, system = joined, how = how, made = made, gap_mm = System.Math.Round(best * 304.8, 1) };
`.trim();
