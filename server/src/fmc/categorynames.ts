/**
 * VE-4 / MQ-3: Revit category names are BuiltInCategory tokens (OST_Walls). The add-in drops a name that does not parse,
 * and when none parse it used to take every category. The tools refuse names that are not OST_ tokens, naming each one.
 */
const TOKEN = /^OST_[A-Za-z0-9_]+$/;

export function suggestToken(name: string): string {
  const words = name.trim().replace(/^OST_/i, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  return "OST_" + words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
}

export function categoryNameProblem(names: string[] | null | undefined, field: string): { code: string; message: string; not_parsed: string[]; try: string[] } | null {
  const bad = (names ?? []).filter((n) => !TOKEN.test(String(n ?? "").trim()));
  if (!bad.length) return null;
  return {
    code: "FMC-CATEGORY-UNKNOWN",
    message: `[FMC-CATEGORY-UNKNOWN] ${field} takes BuiltInCategory names such as OST_Walls. Not parsed: ${bad.join(", ")}. Nothing was read, so the reply is not an unfiltered list.`,
    not_parsed: bad,
    try: bad.map(suggestToken),
  };
}
