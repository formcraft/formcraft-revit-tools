/**
 * Dynamo graph tools: the decisions D1-D14 of Tool Research's proposal (decided 2026-11-28), as config values with the
 * recommended defaults. fmc_guard.json may override them under graph_tools.decisions. One rule is code, not config:
 * a graph with Python always needs a person's approval (PYTHON_ALWAYS_NEEDS_PERSON). Nothing here can turn it off.
 */
import type { GuardConfig } from "../policy.js";

/** Hard rule (Emlyn, 28 Nov 2026): Python graphs always need a person. Not read from any config. */
export const PYTHON_ALWAYS_NEEDS_PERSON = true as const;
/** Hard rule (DT-65): every apply of a graph needs a person's approval bound to its plan_hash. */
export const APPLY_ALWAYS_NEEDS_PERSON = true as const;

export type PythonPolicy = "off" | "person_approves_each_hash" | "signed_kit_only";

export interface GraphDecisions {
  /** D1 */ python_policy: PythonPolicy;
  /** D2 */ allowlist_owner: string;
  /** D2: empty means %LOCALAPPDATA%\Formcraft\graph_allowlist.json */ allowlist_file: string;
  /** D3 */ allowed_packages: Array<{ name: string; version?: string }>;
  /** D3 */ python_engine: string;
  /** D3 */ third_party_packages: Array<{ name: string; version?: string }>;
  /** D4 */ drafts_folder: string;
  /** D4 */ tier_p_runs: "none" | "preview_scratch_only";
  /** D5 */ dynamo_player_kit_graphs: boolean;
  /** D6 */ pane_form_owner: string;
  /** D7 */ generative_engine: "builtin_first" | "generativedesign_first";
  /** D8 */ study_limits: { max_runs: number; max_minutes: number; scratch_only: boolean; fixed_seed: boolean };
  /** D9 */ scheduled_apply: boolean;
  /** D9 */ schedule_registration: "person";
  /** D10 */ formcraft_nodes_signed: boolean;
  /** D11 */ graph_release: "person";
  /** D12: shown for completeness; apply always needs a person (APPLY_ALWAYS_NEEDS_PERSON). */ apply_needs_person: true;
  /** D13 */ pin_min_dynamo: boolean;
  /** D14 */ diagnostics_outside_jail: "read_only" | "off";
  approval_ttl_minutes: number;
}

export const GRAPH_DECISIONS_DEFAULT: Readonly<GraphDecisions> = Object.freeze({
  python_policy: "person_approves_each_hash",
  allowlist_owner: "BIM Manager",
  allowlist_file: "",
  allowed_packages: [
    { name: "GenerativeDesign", version: "8.2.1.0" },
    { name: "DynamoPlayerExtension" },
    { name: "DynamoRevit" },
    { name: "DSRevitNodesUI" },
    { name: "RevitNodes" },
    { name: "DynamoCore" },
  ],
  python_engine: "PythonNet3",
  third_party_packages: [],
  drafts_folder: "00_Formcraft\\Graphs",
  tier_p_runs: "preview_scratch_only",
  dynamo_player_kit_graphs: false,
  pane_form_owner: "builder-7",
  generative_engine: "builtin_first",
  study_limits: { max_runs: 200, max_minutes: 60, scratch_only: true, fixed_seed: true },
  scheduled_apply: false,
  schedule_registration: "person",
  formcraft_nodes_signed: true,
  graph_release: "person",
  apply_needs_person: true,
  pin_min_dynamo: true,
  diagnostics_outside_jail: "read_only",
  approval_ttl_minutes: 30,
});

const POLICIES: PythonPolicy[] = ["off", "person_approves_each_hash", "signed_kit_only"];

function pkgList(value: unknown, fallback: Array<{ name: string; version?: string }>): Array<{ name: string; version?: string }> {
  if (!Array.isArray(value)) return fallback;
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [{ name: item.trim() }];
    if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
      const row = item as { name: string; version?: unknown };
      return [{ name: row.name.trim(), ...(typeof row.version === "string" && row.version.trim() ? { version: row.version.trim() } : {}) }];
    }
    return [];
  });
}

/** The decisions in force: defaults, then fmc_guard.json graph_tools.decisions. Hard rules are never overridden. */
export function graphDecisions(cfg: GuardConfig | Record<string, unknown> | null | undefined): GraphDecisions {
  const d = GRAPH_DECISIONS_DEFAULT;
  const raw = ((cfg as { graph_tools?: { decisions?: unknown } } | null | undefined)?.graph_tools?.decisions ?? {}) as Record<string, unknown>;
  const str = (key: string, fallback: string) => (typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string).trim() : fallback);
  const bool = (key: string, fallback: boolean) => (typeof raw[key] === "boolean" ? (raw[key] as boolean) : fallback);
  const num = (key: string, fallback: number, min: number, max: number) => {
    const v = raw[key];
    return typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
  };
  const limits = (raw.study_limits ?? {}) as Record<string, unknown>;
  const lim = (key: keyof GraphDecisions["study_limits"]) => {
    const v = limits[key];
    const base = d.study_limits[key];
    return typeof base === "number" ? (typeof v === "number" && v > 0 ? v : base) : (typeof v === "boolean" ? v : base);
  };
  const policy = str("python_policy", d.python_policy) as PythonPolicy;
  const tierP = str("tier_p_runs", d.tier_p_runs);
  const engine = str("generative_engine", d.generative_engine);
  return {
    python_policy: POLICIES.includes(policy) ? policy : d.python_policy,
    allowlist_owner: str("allowlist_owner", d.allowlist_owner),
    allowlist_file: str("allowlist_file", d.allowlist_file),
    allowed_packages: pkgList(raw.allowed_packages, d.allowed_packages.map((p) => ({ ...p }))),
    python_engine: str("python_engine", d.python_engine),
    third_party_packages: pkgList(raw.third_party_packages, []),
    drafts_folder: str("drafts_folder", d.drafts_folder).replace(/^[\\/]+|[\\/]+$/g, "").replace(/\.\.+/g, "") || d.drafts_folder,
    tier_p_runs: tierP === "none" ? "none" : "preview_scratch_only",
    dynamo_player_kit_graphs: bool("dynamo_player_kit_graphs", d.dynamo_player_kit_graphs),
    pane_form_owner: str("pane_form_owner", d.pane_form_owner),
    generative_engine: engine === "generativedesign_first" ? "generativedesign_first" : "builtin_first",
    study_limits: {
      max_runs: lim("max_runs") as number, max_minutes: lim("max_minutes") as number,
      scratch_only: lim("scratch_only") as boolean, fixed_seed: lim("fixed_seed") as boolean,
    },
    // Never configurable to true while D9 says "no scheduled apply"; a config true is ignored.
    scheduled_apply: false,
    schedule_registration: "person",
    formcraft_nodes_signed: bool("formcraft_nodes_signed", d.formcraft_nodes_signed),
    graph_release: "person",
    apply_needs_person: true,
    pin_min_dynamo: bool("pin_min_dynamo", d.pin_min_dynamo),
    diagnostics_outside_jail: str("diagnostics_outside_jail", d.diagnostics_outside_jail) === "off" ? "off" : "read_only",
    approval_ttl_minutes: num("approval_ttl_minutes", d.approval_ttl_minutes, 1, 30),
  };
}
