/**
 * The recipe tree (docs/PLAN_RECIPE_TREE.md, T0): the whole building as one recipe made of smaller recipes. A node has
 * a kind (project, building, level, zone, room, assembly, system, family, component), inputs, references, and either
 * children or the Formcraft tool that makes it (a ceiling from fmc_ceiling, a casework run from fmc_casework, a family
 * from its recipe through fmc_recipe). Children inherit their ancestors' inputs: a tool's arguments use ${var.<input>},
 * so a room's width reaches its ceiling. Every node has a revision (a hash of what it is made from, children included);
 * a plan compares them with the last build and lists only what changed. Pure apart from the tool calls it is given.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { fill } from "../hub/flows.js";

export const KINDS = ["project", "building", "level", "zone", "department", "room", "assembly", "system", "family", "component", "group", "library"] as const;

export interface TreeNode {
  id: string;
  kind: (typeof KINDS)[number];
  name?: string;
  inputs?: Record<string, unknown>;
  refs?: Record<string, string>;
  /** The Formcraft tool that makes this node, and its arguments (${var.x} for inherited inputs). */
  make?: { tool: string; args: Record<string, unknown> };
  children?: TreeNode[];
  /** A person's recorded change to what the tree would make (adopted or kept as an override: T3). */
  overrides?: Array<{ what: string; by: string; at: string }>;
}

export const NODE: z.ZodType<TreeNode> = z.lazy(() => z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "a node id is letters, digits, _ . -"),
  kind: z.enum(KINDS),
  name: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  refs: z.record(z.string(), z.string()).optional(),
  make: z.object({ tool: z.string().regex(/^fmc_[a-z_]+$/, "a node is made by a Formcraft tool (fmc_…)"), args: z.record(z.string(), z.unknown()).default({}) }).optional(),
  children: z.array(NODE).optional(),
  overrides: z.array(z.object({ what: z.string(), by: z.string(), at: z.string() })).optional(),
})) as z.ZodType<TreeNode>;

export const TREE = z.object({ schema: z.literal("fmc-tree/0.1").default("fmc-tree/0.1"), project: z.string().default(""), root: NODE });
export type Tree = z.infer<typeof TREE>;

/** Tools a tree may not run: the tree itself and the flow runner (no loops), and the ones that publish or release. */
export const NOT_IN_TREE = new Set(["fmc_tree", "fmc_flow", "fmc_issue", "fmc_workshare"]);

export interface Resolved { node: TreeNode; path: string[]; vars: Record<string, unknown>; args?: Record<string, unknown>; error?: string; revision: string }

const hash = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

/**
 * Every node with its inherited inputs (nearest ancestor wins), its tool arguments filled in, and its revision
 * (its own resolved content plus its children's revisions, so a change anywhere below shows on every ancestor).
 */
export function resolve(tree: Tree): Resolved[] {
  const out: Resolved[] = [];
  const walk = (n: TreeNode, path: string[], inherited: Record<string, unknown>): string => {
    const vars = { ...inherited, ...(n.inputs ?? {}) };
    let args: Record<string, unknown> | undefined, error: string | undefined;
    if (n.make) {
      if (NOT_IN_TREE.has(n.make.tool)) error = `${n.make.tool} can't run in the tree`;
      else try { args = fill(n.make.args, vars, {}) as Record<string, unknown>; } catch (e) { error = e instanceof Error ? e.message : String(e); }
    }
    const at = out.length;
    out.push({ node: n, path: [...path, n.id], vars, args, error, revision: "" });
    const kids = (n.children ?? []).map((c) => walk(c, [...path, n.id], vars));
    const rev = hash({ kind: n.kind, inputs: n.inputs ?? {}, refs: n.refs ?? {}, tool: n.make?.tool, args: args ?? n.make?.args ?? null, kids });
    out[at].revision = rev;
    return rev;
  };
  walk(tree.root, [], {});
  return out;
}

/** What is wrong with a tree before anything runs: duplicate ids, unknown tools, values a node needs and nothing gives. */
export function treeProblems(tree: Tree, toolExists: (tool: string) => boolean): string[] {
  const p: string[] = [];
  const seen = new Set<string>();
  for (const r of resolve(tree)) {
    if (seen.has(r.node.id)) p.push(`${r.path.join(" › ")}: the id ${r.node.id} is used twice`);
    seen.add(r.node.id);
    if (r.error) p.push(`${r.path.join(" › ")}: ${r.error}`);
    if (r.node.make && !NOT_IN_TREE.has(r.node.make.tool) && !toolExists(r.node.make.tool)) p.push(`${r.path.join(" › ")}: no tool ${r.node.make.tool}`);
    if (!r.node.make && !(r.node.children ?? []).length && r.node.kind !== "group") p.push(`${r.path.join(" › ")}: makes nothing (no tool and no children)`);
  }
  return p;
}

export interface BuiltState { built_at: string; revisions: Record<string, string> }

export interface PlanLine { id: string; path: string; kind: string; state: "new" | "changed" | "unchanged"; tool?: string; error?: string }

/** Each node against the last build: new, changed or unchanged; only the nodes that make something are built. */
export function planTree(tree: Tree, last: BuiltState | null): PlanLine[] {
  // a library's rooms are templates (T5): copied into the building, never built themselves
  const inLibrary = new Set(resolve(tree).filter((r) => r.path.slice(0, -1).some((id) => findNode(tree, id)?.kind === "library") || r.node.kind === "library").map((r) => r.node.id));
  return resolve(tree).map((r) => {
    const before = last?.revisions[r.node.id];
    const state = before === undefined ? "new" : before === r.revision ? "unchanged" : "changed";
    return { id: r.node.id, path: r.path.join(" › "), kind: r.node.kind, state, ...(r.node.make && !inLibrary.has(r.node.id) ? { tool: r.node.make.tool } : {}), ...(r.error ? { error: r.error } : {}) };
  });
}

/** The revisions to record after a build of these nodes (the others keep what they had). */
export function recordBuilt(tree: Tree, last: BuiltState | null, built: string[], now: Date): BuiltState {
  const revs = { ...(last?.revisions ?? {}) };
  const resolved = new Map(resolve(tree).map((r) => [r.node.id, r]));
  for (const id of built) { const r = resolved.get(id); if (r) revs[id] = r.revision; }
  // an ancestor is built once every node under it that makes something is built at its current revision
  for (const r of resolve(tree)) {
    const under = resolve({ ...tree, root: r.node }).filter((x) => x.node.make);
    if (under.length && under.every((x) => revs[x.node.id] === resolved.get(x.node.id)?.revision)) revs[r.node.id] = r.revision;
  }
  return { built_at: now.toISOString(), revisions: revs };
}

/** A node by id, and its place (for set). */
export function findNode(tree: Tree, id: string): TreeNode | null {
  const walk = (n: TreeNode): TreeNode | null => n.id === id ? n : (n.children ?? []).map(walk).find(Boolean) ?? null;
  return walk(tree.root);
}
