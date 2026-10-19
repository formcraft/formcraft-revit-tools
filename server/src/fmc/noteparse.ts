/**
 * Mark & Review R3 (docs/PLAN_MARK_REVIEW.md): the offline note parser and the fix planner. No AI, no network.
 *
 * parseNote reads a ticket note (typed, or a voice transcript with filler and no punctuation) into intents:
 * "make it 1200 wide", "raise it to 2700", "move it 300 left", "change to 1026 single", "wrong material, use
 * stainless", "delete this", "needs clearance", "same as the other one". What it can't read is "unclear" and goes to
 * the AI with the ticket. planFix turns intents and the element's facts into a structured fix (a list of ops, each with
 * a sentence a person reads), always as a dry run: applying it is R6.
 *
 * Rules kept here: a material must be in the kit's list passed in (rule 7: kit data comes from the kit); engineering
 * values (pipe and duct sizes, loads, ratings, structural sections) are never set, they go to an engineer (rule 5).
 * Pure: text and facts in, intents and a plan out.
 */

export type IntentKind = "set_param" | "move" | "resize" | "raise_lower" | "swap_type" | "material" | "delete" | "add_clearance" | "same_as" | "unclear";
/** Directions are as seen in the view: left/right and up/down on the screen, forward = away from the viewer. */
export type Direction = "left" | "right" | "up" | "down" | "forward" | "back";

export interface Intent {
  kind: IntentKind;
  /** 0..1: how sure the parser is. Below 0.5 the planner treats it as unclear. */
  confidence: number;
  /** The words that were matched (after filler words were dropped and numbers written as digits). */
  said: string;
  /** resize, set_param: the parameter heard (Width, Height, Depth, Length, Thickness, Sill Height, Offset, ...). */
  param?: string;
  /** resize, set_param, raise_lower: the value to set, mm. */
  value_mm?: number;
  /** resize, raise_lower: a signed change, mm (+ bigger / higher). move: the distance, mm. */
  by_mm?: number;
  /** set_param: a text value ("set mark to D-01"). */
  value_text?: string;
  direction?: Direction;
  type_name?: string;
  /** material: the kit material it matched (only names from the list passed in). */
  material?: string;
  /** material: several kit materials matched the words equally. */
  candidates?: string[];
  /** same_as: the words naming the other element. */
  ref?: string;
  /** set_param: an engineering value (sizes, loads, ratings): never set by a tool (rule 5). */
  engineering?: boolean;
  /** Why it is unclear or weak. */
  why?: string;
}

export interface ParseOptions {
  /** The kit's material names (FMC_Materials.json). A material intent only ever names one of these. */
  materials?: string[];
}

// ---------------------------------------------------------------- normalising

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const isNumWord = (w: string) => w in ONES || w in TENS || w === "hundred" || w === "thousand";

/** "twelve hundred" → 1200, "two point four" → 2.4, "a hundred and fifty" → 150. A lone "one" or "a" stays a word. */
export function wordsToDigits(s: string): string {
  const toks = s.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const core = (t: string) => t.toLowerCase().replace(/[^a-z]/g, "");
  let i = 0;
  while (i < toks.length) {
    const c = core(toks[i]);
    const startsRun = isNumWord(c) || (c === "a" && i + 1 < toks.length && /^(hundred|thousand)$/.test(core(toks[i + 1])));
    if (!startsRun) { out.push(toks[i]); i++; continue; }
    let total = 0, current = 0, j = i, words = 0, last = "";
    for (; j < toks.length; j++) {
      const w = core(toks[j]);
      if (w === "a" && j === i) { current = 1; last = "a"; continue; }
      if (w === "and" && (last === "hundred" || last === "thousand") && j + 1 < toks.length && (core(toks[j + 1]) in ONES || core(toks[j + 1]) in TENS)) continue;
      if (w in ONES) { if (last in ONES && !(last in TENS)) break; current += ONES[w]; }
      else if (w in TENS) { if ((last in ONES) || (last in TENS)) break; current += TENS[w]; }
      else if (w === "hundred") current = (current || 1) * 100;
      else if (w === "thousand") { total += (current || 1) * 1000; current = 0; }
      else break;
      words++; last = w;
      if (/[^a-z0-9]$/i.test(toks[j]) && j + 1 < toks.length) { j++; break; } // "hundred," ends the run
    }
    let value = String(total + current);
    // decimals: "two point four"
    if (j + 1 < toks.length && core(toks[j]) === "point" && core(toks[j + 1]) in ONES && ONES[core(toks[j + 1])] < 10) {
      let dec = "";
      j++;
      while (j < toks.length && core(toks[j]) in ONES && ONES[core(toks[j])] < 10) { dec += ONES[core(toks[j])]; j++; }
      value += "." + dec;
    }
    const single = words === 1 && (core(toks[i]) === "one") && !value.includes(".");
    if (single) out.push(toks[i]);
    else {
      const trail = /[^a-z0-9]+$/i.exec(toks[j - 1])?.[0] ?? "";
      out.push(value + trail);
    }
    i = single ? i + 1 : j;
  }
  return out.join(" ");
}

const FILLER = [
  "uh+h*", "um+", "umm+", "erm*", "ah+", "hmm+", "mm+hm+", "please", "pls", "kindly", "i think", "i guess", "i mean", "you know",
  "basically", "actually", "just", "maybe", "perhaps", "okay", "ok", "alright", "yeah", "yes", "well", "so", "sort of",
  "kind of", "can you", "could you", "would you", "will you", "can we", "could we", "let's", "lets", "we need to", "you need to",
  "i need you to", "i want you to", "i'd like you to", "i would like you to", "i want", "go ahead and", "a bit", "a little",
  "if possible", "thanks", "thank you", "hey", "claude",
];
const FILLER_RE = new RegExp(`\\b(?:${FILLER.join("|")})\\b`, "gi");

/** Lower-case-safe normalising: digits for words, one spelling per unit, no filler. Keeps the original case. */
export function normalise(text: string): string {
  let s = ` ${text} `.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/(\p{L})-(\p{L})/gu, "$1 $2");
  s = s.replace(/(\d),(\d{3})\b/g, "$1$2");
  s = wordsToDigits(s);
  s = s.replace(FILLER_RE, " ");
  s = s.replace(/(\d)\s*(?:millimet(?:er|re)s?|mils?|mm)\b/gi, "$1 mm")
    .replace(/(\d)\s*(?:centimet(?:er|re)s?|cms?)\b/gi, "$1 cm")
    .replace(/(\d)\s*(?:met(?:er|re)s?|m)\b/gi, "$1 m");
  s = s.replace(/[,"():]/g, " ").replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n[ \n]*/g, "\n").trim();
  return s;
}

/** A quantity in mm, or null when it can't be read safely ("move it 3": 3 what?). */
export function toMm(n: number, unit: string | undefined): { mm: number; conf: number } | null {
  if (unit === "mm") return { mm: n, conf: 1 };
  if (unit === "cm") return { mm: n * 10, conf: 1 };
  if (unit === "m") return n >= 50 ? { mm: n, conf: 0.6 } : { mm: Math.round(n * 1000 * 1000) / 1000, conf: 1 }; // "1200 m" is a slip for mm
  if (n >= 10) return { mm: n, conf: 0.95 }; // the house unit is mm
  if (!Number.isInteger(n)) return { mm: Math.round(n * 1000 * 1000) / 1000, conf: 0.7 }; // "0.3" is metres
  return null;
}

// ---------------------------------------------------------------- patterns

const Q = String.raw`(\d+(?:\.\d+)?)(?:\s?(mm|cm|m)\b)?`;
/** Up to three words between a verb and what follows ("move the door frame 300 left"), never "to"/"by". */
const W = String.raw`(?:\s+(?!(?:to|by)\b)[a-z']+){0,3}?`;
const DIR = String.raw`(left|right|up|upwards|down|downwards|forwards?|ahead|backwards?|back|backward)`;
const DIMS: Record<string, string> = {
  wide: "Width", width: "Width", high: "Height", tall: "Height", height: "Height", deep: "Depth", depth: "Depth",
  long: "Length", length: "Length", thick: "Thickness", thickness: "Thickness",
};
const COMPARE: Record<string, [string, number]> = {
  wider: ["Width", 1], narrower: ["Width", -1], taller: ["Height", 1], shorter: ["Length", -1], deeper: ["Depth", 1],
  shallower: ["Depth", -1], longer: ["Length", 1], thicker: ["Thickness", 1], thinner: ["Thickness", -1],
};
const VERB_DIM: Record<string, [string, number]> = {
  widen: ["Width", 1], narrow: ["Width", -1], extend: ["Length", 1], lengthen: ["Length", 1], shorten: ["Length", -1], deepen: ["Depth", 1],
};
const NAMED: Record<string, string> = {
  "sill height": "Sill Height", sill: "Sill Height", "head height": "Head Height", "base offset": "Base Offset", "top offset": "Top Offset",
  "offset from host": "Offset from Host", "elevation from level": "Elevation from Level", offset: "Offset",
  "top extension": "Top Extension", "base extension": "Base Extension",
};
/** Engineering properties: a note that sets one of these goes to an engineer (rule 5). */
const ENG_WORDS = String.raw`diameter|pipe size|duct size|cable size|conduit size|dn\s?\d+|nominal size|load|loading|rating|rated|amps?|amperage|voltage|kw|kva|wattage|power rating|flow rate|pressure|lux|beam size|column size|section size|rebar|reinforcement|breaker|fuse|fire rating|demand factor|u value|r value`;
const ENG_RE = new RegExp(String.raw`\b(${ENG_WORDS})\b`, "i");
const ENG_UNIT_RE = /\d(?:\s?(kw|kva|amps?|volts?|watts?|lux|kn|kpa|bar|mm2|mm²|sq ?mm)|(a|v|w))\b/i;
const ENG_VERB_RE = /\b(upsize|downsize|resize|bigger|smaller|larger|increase|reduce)\b/i;

const dirOf = (w: string): Direction => {
  if (/^up/.test(w)) return "up";
  if (/^down/.test(w)) return "down";
  if (/^(forward|ahead)/.test(w)) return "forward";
  if (/^back/.test(w)) return "back";
  return w as Direction;
};

interface Hit { start: number; end: number; intents: Intent[] }

const round = (x: number) => Math.round(x * 100) / 100;

function material(words: string, list: string[]): { material?: string; candidates?: string[] } {
  const said = new Set(words.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
  if (!said.size || !list.length) return {};
  const scored = list.map((m) => {
    const toks = new Set(m.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && t !== "fmc"));
    let score = 0;
    for (const t of toks) if (said.has(t) || [...said].some((w) => w.length >= 4 && (t.startsWith(w) || w.startsWith(t)))) score++;
    return { m, score };
  }).filter((x) => x.score > 0);
  if (!scored.length) return {};
  const best = Math.max(...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best).map((x) => x.m);
  return top.length === 1 ? { material: top[0] } : { candidates: top };
}

const STOP = new Set(["the", "this", "that", "it", "its", "it's", "a", "an", "is", "be", "should", "needs", "need", "to", "and", "of", "one",
  "here", "there", "with", "for", "use", "make", "change", "instead", "wrong", "material", "finish", "type", "please", "in", "on", "all",
  "them", "these", "those", "we", "you", "i", "me", "my", "our", "has", "have", "must", "will", "would", "can", "now", "also", "then", "too",
  "very", "more", "less", "not", "no", "but", "or", "as", "at", "by", "from", "up", "down", "into", "onto", "out", "over", "under", "fine", "good"]);

/** One clause (a sentence): every pattern, earliest-listed wins where two overlap. */
function parseClause(low: string, orig: string, opts: ParseOptions): Intent[] {
  const list = opts.materials ?? [];
  const hits: Hit[] = [];
  const add = (start: number, end: number, ...intents: Intent[]) => {
    if (hits.some((h) => start < h.end && end > h.start)) return;
    hits.push({ start, end, intents });
  };
  const each = (re: RegExp, f: (m: RegExpExecArray) => Intent[] | Intent | null) => {
    const g = new RegExp(re.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = g.exec(low))) {
      const r = f(m);
      if (r) add(m.index, m.index + m[0].length, ...(Array.isArray(r) ? r : [r]));
      if (m[0].length === 0) g.lastIndex++;
    }
  };
  const q = (n: string, u: string | undefined) => toMm(Number(n), u?.toLowerCase());
  const said = (m: RegExpExecArray) => orig.slice(m.index, m.index + m[0].length).trim();
  const unclear = (m: RegExpExecArray, why: string, conf = 0.2): Intent => ({ kind: "unclear", confidence: conf, said: said(m), why });

  // Engineering values first: never set by a tool (rule 5).
  if ((ENG_RE.test(low) && (/\d/.test(low) || ENG_VERB_RE.test(low))) || ENG_UNIT_RE.test(low)) {
    const u = ENG_UNIT_RE.exec(low);
    const w = ENG_RE.exec(low)?.[1] ?? u?.[1] ?? u?.[2] ?? "size";
    return [{ kind: "set_param", confidence: 0.8, said: orig.trim(), param: w, engineering: true, why: "an engineering value: ask an engineer (rule 5)" }];
  }

  // Named parameters (before resize, so "sill height 900" isn't Height)
  each(new RegExp(String.raw`\b(sill height|sill|head height|base offset|top offset|offset from host|elevation from level|offset|top extension|base extension)\b(?:\s+(?:should be|needs to be|has to be|must be|to be|is|of|at|=|to|should))?\s+(?:at\s+)?${Q}`), (m) => {
    const v = q(m[2], m[3]);
    return v ? { kind: "set_param", confidence: round(0.9 * v.conf), said: said(m), param: NAMED[m[1]], value_mm: v.mm } : unclear(m, `${m[2]} what? Say mm or m`);
  });
  // "too narrow, make it 1026": the complaint names the size, the number is the value
  each(new RegExp(String.raw`\btoo (narrow|wide|short|tall|shallow|deep|low|high)\b.*?\b(?:make it|should be|needs to be|has to be|to|at)\s+${Q}`), (m) => {
    const v = q(m[2], m[3]);
    if (!v) return unclear(m, `${m[2]} what? Say mm or m`);
    if (m[1] === "low" || m[1] === "high") return { kind: "raise_lower", confidence: round(0.8 * v.conf), said: said(m), value_mm: v.mm };
    const param = /narrow|wide/.test(m[1]) ? "Width" : /short|tall/.test(m[1]) ? "Height" : "Depth";
    return { kind: "resize", confidence: round(0.8 * v.conf), said: said(m), param, value_mm: v.mm };
  });
  // Resize
  each(new RegExp(String.raw`\b${Q}\s*x\s*${Q}\b`), (m) => {
    if (/\b(change|swap|switch|replace|use|type)\b/.test(low)) return null; // "change to 254x146 UB" names a type
    const a = q(m[1], m[2] ?? m[4]), b = q(m[3], m[4]);
    return a && b ? [{ kind: "resize", confidence: round(0.65 * Math.min(a.conf, b.conf)), said: said(m), param: "Width", value_mm: a.mm },
      { kind: "resize", confidence: round(0.65 * Math.min(a.conf, b.conf)), said: said(m), param: "Height", value_mm: b.mm }] : unclear(m, "a size without units");
  });
  each(new RegExp(String.raw`(?:\b(?:make|set|change)(?:\s+(?:it|this|that|them))?\s+(?:to\s+)?|\b(?:should|must|needs to|has to)\s+be\s+)?\b${Q}\s+(wide|high|tall|deep|long|thick)\b`), (m) => {
    const v = q(m[1], m[2]);
    return v ? { kind: "resize", confidence: round(0.9 * v.conf), said: said(m), param: DIMS[m[3]], value_mm: v.mm } : unclear(m, `${m[1]} what? Say mm or m`);
  });
  each(new RegExp(String.raw`\b(width|height|depth|length|thickness)\b(?:\s+from\s+\d+(?:\.\d+)?(?:\s?(?:mm|cm|m))?)?(?:\s+(?:should be|should|needs to be|has to be|must be|to be|is|of|at|=|to|becomes))?\s+${Q}`), (m) => {
    const v = q(m[2], m[3]);
    return v ? { kind: "resize", confidence: round(0.9 * v.conf), said: said(m), param: DIMS[m[1]], value_mm: v.mm } : unclear(m, `${m[2]} what? Say mm or m`);
  });
  each(new RegExp(String.raw`\b(increase|reduce|decrease|cut|trim|change|make)\b(?:\s+the)?\s+(width|height|depth|length|thickness)\s+(by|to)\s+${Q}`), (m) => {
    const v = q(m[4], m[5]);
    if (!v) return unclear(m, `${m[4]} what? Say mm or m`);
    if (m[3] === "to") return { kind: "resize", confidence: round(0.9 * v.conf), said: said(m), param: DIMS[m[2]], value_mm: v.mm };
    if (!/increase|reduce|decrease|cut|trim/.test(m[1])) return unclear(m, "bigger or smaller?", 0.3);
    return { kind: "resize", confidence: round(0.9 * v.conf), said: said(m), param: DIMS[m[2]], by_mm: /increase/.test(m[1]) ? v.mm : -v.mm };
  });
  each(new RegExp(String.raw`\b(widen|narrow|extend|lengthen|shorten|deepen)\b${W}\s+(?:(by|to)\s+)?${Q}`), (m) => {
    const v = q(m[3], m[4]);
    if (!v) return unclear(m, `${m[3]} what? Say mm or m`);
    const [param, sign] = VERB_DIM[m[1]];
    return m[2] === "to" ? { kind: "resize", confidence: round(0.85 * v.conf), said: said(m), param, value_mm: v.mm }
      : { kind: "resize", confidence: round(0.85 * v.conf), said: said(m), param, by_mm: sign * v.mm };
  });
  each(new RegExp(String.raw`\b(?:${Q}\s+(wider|narrower|taller|shorter|deeper|shallower|longer|thicker|thinner)|(wider|narrower|taller|shorter|deeper|shallower|longer|thicker|thinner)\s+by\s+${Q})\b`), (m) => {
    const word = m[3] ?? m[4], v = m[1] ? q(m[1], m[2]) : q(m[5], m[6]);
    if (!v) return unclear(m, "how much? Say mm or m");
    const [param, sign] = COMPARE[word];
    return { kind: "resize", confidence: round((word === "shorter" ? 0.6 : 0.85) * v.conf), said: said(m), param, by_mm: sign * v.mm,
      ...(word === "shorter" ? { why: "shorter: Length or Height?" } : {}) };
  });
  // Raise and lower
  each(new RegExp(String.raw`\b(raise|lift|jack|hike|lower|drop|sink)\b${W}(?:\s+(to|by))?\s+(?:a height of\s+)?${Q}`), (m) => {
    const v = q(m[3], m[4]);
    if (!v) return unclear(m, `${m[3]} what? Say mm or m`);
    const up = /raise|lift|jack|hike/.test(m[1]);
    return m[2] === "to" ? { kind: "raise_lower", confidence: round(0.9 * v.conf), said: said(m), value_mm: v.mm }
      : { kind: "raise_lower", confidence: round(0.85 * v.conf), said: said(m), by_mm: up ? v.mm : -v.mm };
  });
  // Move: distance then direction, direction then distance
  each(new RegExp(String.raw`\b(?:move|shift|push|slide|nudge|bring|put|take|offset|pull)\b${W}(?:\s+by)?\s+${Q}(?:\s+(?:to the|to|towards the|towards|further|more))?\s+${DIR}\b`), (m) => {
    const v = q(m[1], m[2]);
    return v ? { kind: "move", confidence: round(0.9 * v.conf), said: said(m), by_mm: v.mm, direction: dirOf(m[3]) } : unclear(m, `${m[1]} what? Say mm or m`);
  });
  each(new RegExp(String.raw`\b(?:move|shift|push|slide|nudge|bring|put|take|pull)\b${W}\s+(?:to the\s+|towards the\s+)?${DIR}(?:\s+by)?\s+${Q}`), (m) => {
    const v = q(m[2], m[3]);
    return v ? { kind: "move", confidence: round(0.9 * v.conf), said: said(m), by_mm: v.mm, direction: dirOf(m[1]) } : unclear(m, `${m[2]} what? Say mm or m`);
  });
  // Implied: "higher by 100", "100 lower", "should be at 2700", "mount it at 1200 above the floor"
  each(new RegExp(String.raw`\b(?:(higher|lower)\s+by\s+${Q}|${Q}\s+(higher|lower)\b)`), (m) => {
    const v = m[2] ? q(m[2], m[3]) : q(m[4], m[5]);
    const up = (m[1] ?? m[6]) === "higher";
    return v ? { kind: "raise_lower", confidence: round(0.8 * v.conf), said: said(m), by_mm: up ? v.mm : -v.mm } : unclear(m, "how much? Say mm or m");
  });
  each(new RegExp(String.raw`\b(?:(?:should be|should sit|needs to be|has to be|must be|mount(?:ed)?|fix(?:ed)?|install(?:ed)?|place(?:d)?|sits?|set it|put it)\s+(?:it\s+)?at\s+(?:a height of\s+)?${Q}(?:\s+(?:above|from|off)\s+(?:the\s+)?(?:finished\s+)?(?:floor|ffl|ground|level|slab))?|(?:mounting height|height above (?:the\s+)?floor)(?:\s+(?:should be|of|is|to|at))?\s+${Q}|at\s+${Q}\s+(?:above|from|off|aff|affl|ffl)\b(?:\s+(?:the\s+)?(?:finished\s+)?(?:floor|ffl|ground|level|slab))?)`), (m) => {
    const v = m[1] ? q(m[1], m[2]) : m[3] ? q(m[3], m[4]) : q(m[5], m[6]);
    return v ? { kind: "raise_lower", confidence: round(0.8 * v.conf), said: said(m), value_mm: v.mm } : unclear(m, "at what height? Say mm or m");
  });
  each(new RegExp(String.raw`\b${Q}\s+(?:to the|further|more)?\s*(left|right|forwards?|backwards?|up|down)\b`), (m) => {
    const v = q(m[1], m[2]);
    return v ? { kind: "move", confidence: round(0.7 * v.conf), said: said(m), by_mm: v.mm, direction: dirOf(m[3]) } : unclear(m, `${m[1]} what? Say mm or m`);
  });
  each(new RegExp(String.raw`\b(?:move|shift|nudge|push|slide)\b${W}\s+(?:by\s+)?${Q}`), (m) => {
    const v = q(m[1], m[2]);
    return v ? { kind: "move", confidence: 0.4, said: said(m), by_mm: v.mm, why: "which way? left, right, up, down, forward or back" } : unclear(m, `${m[1]} what, and which way?`);
  });
  each(new RegExp(String.raw`\b(?:move|shift|nudge|push|slide)\b${W}\s+(?:to the\s+)?${DIR}\b`), (m) =>
    ({ kind: "move", confidence: 0.35, said: said(m), direction: dirOf(m[1]), why: "how far? say the distance in mm" }));

  // Material, when the note names it ("wrong material, use stainless", "finish should be oak")
  if (/\b(material|finish|finishes|finished|made of|made from|cladding|clad)\b/.test(low)) {
    const r = material(low, list);
    if (r.material || r.candidates || !hits.length) {
      const words = low.replace(/^.*?\b(?:use|to|be|in|with|of|from)\b\s*/, "").trim();
      add(0, low.length, r.material ? { kind: "material", confidence: 0.85, said: orig.trim(), material: r.material }
        : r.candidates ? { kind: "material", confidence: 0.4, said: orig.trim(), candidates: r.candidates, why: `which one: ${r.candidates.join(", ")}?` }
        : { kind: "material", confidence: 0.3, said: orig.trim(), why: list.length ? `"${words}" isn't a material in the kit's list: a kit change request (rule 7)` : "no kit material list to match against" });
    }
  }
  // Swap the type, or a material named without the word "material"
  const typeOrMaterial = (m: RegExpExecArray, rest: string, explicit: boolean, conf: number): Intent | null => {
    const r = explicit ? {} : material(rest, list);
    if (r.material) return { kind: "material", confidence: 0.75, said: said(m), material: r.material };
    if (r.candidates) return { kind: "material", confidence: 0.4, said: said(m), candidates: r.candidates, why: `which one: ${r.candidates.join(", ")}?` };
    const at = m.index + m[0].lastIndexOf(rest);
    const name = orig.slice(at, at + rest.length).replace(/\s+(?:instead|one|please|type)$/i, "").trim();
    if (!name || /^\d+(?:\.\d+)?\s?(?:mm|cm|m)$/i.test(name)) return null; // "change to 1200 mm": a size, not a type
    return { kind: "swap_type", confidence: /^\d+(?:\.\d+)?$/.test(name) ? Math.min(conf, 0.6) : conf, said: said(m), type_name: name };
  };
  each(/\b(?:use|should be|make it|needs to be|put|change (?:it |this |that )?to|swap (?:it |this |that )?(?:to|for|with)|switch (?:it |this |that )?to)\s+(?:an?\s+|the\s+)?type\s+(.+)$/, (m) => typeOrMaterial(m, m[1], true, 0.85));
  each(/\bwrong type\b.*?\b(?:use|should be|make it|needs to be|change (?:it )?to)\s+(?:an?\s+|the\s+)?(.+)$/, (m) => typeOrMaterial(m, m[1], true, 0.8));
  each(/\b(?:change|swap|switch|replace|convert)\b(?:\s+(?:it|this|that|them|the type|type))?\s+(?:to|with|for|into)\s+(?:an?\s+|the\s+)?(.+)$/, (m) => typeOrMaterial(m, m[1], false, 0.75));
  each(/\b(?:use|should be|needs to be|has to be|make it|in)\s+(?:an?\s+|the\s+)?(.+?)(?:\s+instead)?$/, (m) => {
    const r = material(m[1], list);
    if (r.material) return { kind: "material", confidence: 0.7, said: said(m), material: r.material };
    if (r.candidates) return { kind: "material", confidence: 0.4, said: said(m), candidates: r.candidates, why: `which one: ${r.candidates.join(", ")}?` };
    return /^use\b/.test(m[0]) ? typeOrMaterial(m, m[1], true, 0.5) : null;
  });

  // Delete (never "don't delete")
  each(/\b(delete|remove|erase|get rid of|take (?:it |this |that |them )?(?:out|away)|not needed|no longer needed|isn't needed|is not needed|don't need (?:it|this|that)|do not need (?:it|this|that)|doesn't belong|does not belong|shouldn't be (?:here|there)|should not be (?:here|there)|not required|redundant)\b/, (m) => {
    if (/\b(?:don't|do not|never|no need to|shouldn't|should not)\s+(?:\w+\s+)?$/.test(low.slice(0, m.index))) return null;
    if (/^\s*(?:\S+\s+){0,2}\d/.test(low.slice(m.index + m[0].length))) return unclear(m, "delete, or change by a number?", 0.25); // "remove 100 from the width"
    return { kind: "delete", confidence: /delete|remove|erase|get rid/.test(m[1]) ? 0.9 : 0.75, said: said(m) };
  });
  // Clearance
  each(new RegExp(String.raw`\b(?:${Q}\s+(?:of\s+)?(?:clearance|clear space|clear zone|access space|service space|working space)|(?:clearance|clear space|clear zone|access space|service space|maintenance space|working space)(?:\s+(?:of|to|should be|is))?\s+${Q}|clearances?|clear space|clear zone|access zone|access space|service space|maintenance space|working space|keep (?:it |this )?clear|room to open|space to open|needs? (?:more )?(?:space|room) (?:around|in front|to)\b)`), (m) => {
    const n = m[1] ?? m[3];
    if (n) {
      const v = q(n, m[2] ?? m[4]);
      return v ? { kind: "add_clearance", confidence: round(0.85 * v.conf), said: said(m), value_mm: v.mm } : unclear(m, "clearance of what? Say mm or m");
    }
    return { kind: "add_clearance", confidence: 0.75, said: said(m) };
  });
  // Same as another
  each(/\b(?:same as|same like|the same as|match(?:es|ing)?|identical to|copy (?:of )?|as per|like(?= the\b))\s+(?:the\s+)?(.*)$/, (m) => {
    const ref = m[1].trim();
    if (!ref || /^(?:it|this)$/.test(ref)) return null;
    return { kind: "same_as", confidence: /^like/.test(m[0]) ? 0.6 : 0.8, said: said(m), ref };
  });
  // Generic set: "set mark to D-01", "comments should read check on site"
  each(/\b(?:set|change)\s+(?:the\s+)?([a-z][a-z ]{1,30}?)\s+(?:to|=|as)\s+(.+)$|\b([a-z][a-z ]{1,30}?)\s+should (?:read|say)\s+(.+)$/, (m) => {
    const param = (m[1] ?? m[3]).trim(), valueAt = m.index + m[0].length - (m[2] ?? m[4]).length;
    if (/^(it|this|that|them|type|the type)$/.test(param)) return null;
    const raw = orig.slice(valueAt, m.index + m[0].length).trim();
    const num = new RegExp(`^${Q}$`, "i").exec(raw.toLowerCase());
    const P = param.replace(/\b\w/g, (c) => c.toUpperCase());
    if (num) {
      const v = q(num[1], num[2]);
      return v ? { kind: "set_param", confidence: round(0.75 * v.conf), said: said(m), param: P, value_mm: v.mm } : unclear(m, `${num[1]} what? Say mm or m`);
    }
    return { kind: "set_param", confidence: 0.7, said: said(m), param: P, value_text: raw };
  });

  hits.sort((a, b) => a.start - b.start);
  const found = hits.flatMap((h) => h.intents);
  if (found.length) return found;
  // Nothing matched: unclear, if the clause says anything at all
  const words = low.split(/[^a-z0-9']+/).filter((w) => w && !STOP.has(w));
  if (!words.length) return [];
  return [{ kind: "unclear", confidence: /\d/.test(low) ? 0.2 : 0.1, said: orig.trim(),
    why: /\d/.test(low) ? "a number, but not what to change" : "not a request the offline parser knows: the AI reads it" }];
}

/** A note → its intents, in the order said. An empty note gives one "unclear" with confidence 0. */
export function parseNote(text: string, opts: ParseOptions = {}): Intent[] {
  const norm = normalise(text ?? "");
  if (!norm) return [{ kind: "unclear", confidence: 0, said: "", why: "an empty note" }];
  // sentences: a full stop that isn't a decimal point, ! ? ; and new lines
  const clauses = norm.split(/(?:[.!?;]+(?=\s|$))|\n/).map((c) => c.trim()).filter(Boolean);
  const out: Intent[] = [];
  for (const c of clauses) out.push(...parseClause(c.toLowerCase(), c, opts));
  return out.length ? out : [{ kind: "unclear", confidence: 0.05, said: norm, why: "only filler words" }];
}

/** A reply that asks for something replaces the ticket's intent; a reply that doesn't ("thanks", "see photo") keeps it. */
export function intentAfterReply(previous: Intent[] | undefined, reply: Intent[]): Intent[] {
  return reply.some((i) => i.kind !== "unclear") || !previous?.length ? reply : previous;
}

// ---------------------------------------------------------------- the fix planner

export interface ElementFacts {
  unique_id?: string;
  category?: string;
  family?: string;
  type_name?: string;
  /** Parameter name → value; lengths in mm (numbers, or text like "1026 mm"). */
  params?: Record<string, number | string | null>;
  /** The types this element can change to (its family's loaded types). */
  types?: string[];
  /** "same as the other one": the other element, once a person has pointed at it (R4). */
  reference?: { type_name?: string; unique_id?: string };
  view?: string;
}

export type FixStep =
  | { op: "set_param"; param: string; value_mm?: number; by_mm?: number; value_text?: string; was?: number | string | null; sentence: string }
  | { op: "set_height"; value_mm: number; sentence: string }
  | { op: "move"; frame: "view" | "model"; direction?: Direction; distance_mm: number; vector_mm: [number, number, number]; sentence: string }
  | { op: "change_type"; type_name: string; was?: string; sentence: string }
  | { op: "set_material"; material: string; sentence: string }
  | { op: "delete"; sentence: string }
  | { op: "add_clearance"; value_mm: number; sentence: string };

export interface PlannedFix {
  dry_run: true;
  /** True only when every intent became a step and the plan used the element's facts. */
  ready: boolean;
  steps: Array<FixStep & { unique_id?: string }>;
  /** What the parser or planner couldn't settle: goes to the AI or the person with the ticket. */
  unclear: string[];
  /** Engineering values: never set by a tool (rule 5). */
  ask_engineer: string[];
  /** Already as asked, nothing to do. */
  notes: string[];
  from_note_only: boolean;
  summary: string;
}

/** Categories whose sizes are engineering (pipe, duct, cable tray, conduit sizes; structural sections). */
const ENG_CATEGORIES = /^(pipes?|pipe fittings|flex pipes|ducts?|duct fittings|flex ducts|cable trays?|cable tray fittings|conduits?|conduit fittings|structural framing|structural columns|structural foundations|structural rebar|electrical equipment|electrical circuits|wires)$/i;
const ENG_PARAM = /diameter|size|load|rating|current|amp|voltage|power|flow|pressure|apparent|demand|section|reinforcement|fire rating/i;
const HEIGHT_PARAMS = ["Sill Height", "Elevation from Level", "Offset from Host", "Offset", "Base Offset", "Height Offset From Level"];

const num = (v: unknown): number | null => {
  if (typeof v === "number" && isFinite(v)) return v;
  const m = typeof v === "string" ? /^\s*(-?\d+(?:\.\d+)?)\s*(mm)?\s*$/i.exec(v) : null;
  return m ? Number(m[1]) : null;
};
const fmt = (mm: number) => `${Math.round(mm * 10) / 10} mm`;

/** The element's parameter for a word: the exact name, else the one name containing it; never a guess between two. */
export function resolveParam(want: string, params: Record<string, unknown> | undefined): { name?: string; why?: string } {
  if (!params) return { name: want };
  const names = Object.keys(params), w = want.toLowerCase();
  const exact = names.filter((n) => n.toLowerCase() === w);
  if (exact.length === 1) return { name: exact[0] };
  const has = names.filter((n) => n.toLowerCase().includes(w));
  if (has.length === 1) return { name: has[0] };
  if (has.length > 1) return { why: `"${want}" could be ${has.join(", ")}: say which` };
  return { why: `this element has no ${want} parameter` };
}

/** Intents + the element's facts (or none: from the note alone) → a structured fix, as a dry run. Applies nothing. */
export function planFix(intents: Intent[], facts: ElementFacts | null, opts: ParseOptions = {}): PlannedFix {
  const steps: PlannedFix["steps"] = [], unclear: string[] = [], ask: string[] = [], notes: string[] = [];
  const f = facts && (facts.category || facts.type_name || facts.params || facts.types) ? facts : null;
  const what = f ? [f.type_name, f.category ? `(${f.category})` : ""].filter(Boolean).join(" ") || "the marked element" : "the marked element";
  const engCategory = !!f?.category && ENG_CATEGORIES.test(f.category.trim());
  const push = (s: FixStep) => steps.push(f?.unique_id ? { ...s, unique_id: f.unique_id } : s);
  const materials = opts.materials ?? [];

  for (const i of intents) {
    const q = `"${i.said}"`;
    if (i.kind === "unclear") { unclear.push(`${q}: ${i.why ?? "not understood"}`); continue; }
    if (i.engineering) { ask.push(`${q}: ${i.param ?? "this"} is an engineering value: ask an engineer (rule 5)`); continue; }
    if (i.confidence < 0.5) { unclear.push(`${q}: ${i.why ?? "not sure what is meant"}`); continue; }

    if (i.kind === "resize" || i.kind === "set_param") {
      const want = i.param ?? "";
      if (!want) { unclear.push(`${q}: which size?`); continue; }
      if (ENG_PARAM.test(want) || (engCategory && (i.value_mm !== undefined || i.by_mm !== undefined))) {
        ask.push(`${q}: sizes of ${f?.category ?? "this element"} are engineering values: ask an engineer (rule 5)`); continue;
      }
      const r = resolveParam(want, f?.params);
      if (!r.name) { unclear.push(`${q}: ${r.why}`); continue; }
      if (ENG_PARAM.test(r.name)) { ask.push(`${q}: ${r.name} is an engineering value: ask an engineer (rule 5)`); continue; }
      const was = f?.params ? f.params[r.name] ?? null : undefined;
      const now = num(was);
      const nowTxt = was === undefined ? " (now unknown: planned from the note alone)" : ` (now ${now !== null ? Math.round(now * 10) / 10 : was ?? "empty"})`;
      if (i.value_text !== undefined) {
        if (was !== undefined && String(was ?? "") === i.value_text) { notes.push(`${r.name} is already ${i.value_text}`); continue; }
        push({ op: "set_param", param: r.name, value_text: i.value_text, ...(was !== undefined ? { was } : {}), sentence: `Set ${r.name} to "${i.value_text}"${nowTxt}` });
      } else if (i.value_mm !== undefined) {
        if (now !== null && Math.abs(now - i.value_mm) < 0.5) { notes.push(`${r.name} is already ${fmt(i.value_mm)}`); continue; }
        push({ op: "set_param", param: r.name, value_mm: i.value_mm, ...(was !== undefined ? { was } : {}), sentence: `Set ${r.name} to ${fmt(i.value_mm)}${nowTxt}` });
      } else if (i.by_mm !== undefined) {
        if (f?.params && now === null) { unclear.push(`${q}: ${r.name} has no length to change by ${fmt(Math.abs(i.by_mm))}`); continue; }
        if (now !== null) push({ op: "set_param", param: r.name, value_mm: now + i.by_mm, was, sentence: `Set ${r.name} to ${fmt(now + i.by_mm)} (now ${Math.round(now * 10) / 10}, ${i.by_mm > 0 ? "+" : "−"}${Math.abs(i.by_mm)})` });
        else push({ op: "set_param", param: r.name, by_mm: i.by_mm, sentence: `Make ${r.name} ${fmt(Math.abs(i.by_mm))} ${i.by_mm > 0 ? "bigger" : "smaller"} (now unknown: planned from the note alone)` });
      } else unclear.push(`${q}: to what value?`);
      continue;
    }

    if (i.kind === "raise_lower") {
      if (i.by_mm !== undefined) {
        const d = i.by_mm;
        push({ op: "move", frame: "model", direction: d > 0 ? "up" : "down", distance_mm: Math.abs(d), vector_mm: [0, 0, d], sentence: `${d > 0 ? "Raise" : "Lower"} ${what} by ${fmt(Math.abs(d))}` });
        continue;
      }
      if (i.value_mm === undefined) { unclear.push(`${q}: to what height?`); continue; }
      if (!f?.params) { push({ op: "set_height", value_mm: i.value_mm, sentence: `Set its height above its level to ${fmt(i.value_mm)} (its own parameter: Sill Height, Elevation from Level or Offset; planned from the note alone)` }); continue; }
      const names = Object.keys(f.params);
      const found = HEIGHT_PARAMS.map((h) => names.find((n) => n.toLowerCase() === h.toLowerCase())).filter((n): n is string => !!n);
      if (found.length !== 1) { unclear.push(`${q}: ${found.length ? `which height: ${found.join(", ")}?` : `this element has no height parameter (${HEIGHT_PARAMS.join(", ")})`}`); continue; }
      const p = found[0], now = num(f.params[p]);
      if (now !== null && Math.abs(now - i.value_mm) < 0.5) { notes.push(`${p} is already ${fmt(i.value_mm)}`); continue; }
      push({ op: "set_param", param: p, value_mm: i.value_mm, was: f.params[p], sentence: `Set ${p} to ${fmt(i.value_mm)} (now ${now !== null ? Math.round(now * 10) / 10 : f.params[p] ?? "empty"})` });
      continue;
    }

    if (i.kind === "move") {
      if (!i.direction || !i.by_mm) { unclear.push(`${q}: ${i.why ?? "which way and how far?"}`); continue; }
      const d = i.by_mm;
      // the view's frame: x to the right of the screen, y up the screen, z out of the screen towards the viewer
      const v: Record<Direction, [number, number, number]> = { left: [-d, 0, 0], right: [d, 0, 0], up: [0, d, 0], down: [0, -d, 0], forward: [0, 0, -d], back: [0, 0, d] };
      push({ op: "move", frame: "view", direction: i.direction, distance_mm: d, vector_mm: v[i.direction], sentence: `Move ${what} ${fmt(d)} ${i.direction === "forward" ? "forward (away from you)" : i.direction === "back" ? "back (towards you)" : i.direction}, as seen in the view${f?.view ? ` ${f.view}` : ""}` });
      continue;
    }

    if (i.kind === "swap_type" || i.kind === "same_as") {
      let name = i.kind === "swap_type" ? i.type_name ?? "" : f?.reference?.type_name ?? "";
      if (i.kind === "same_as" && !name) { unclear.push(`${q}: which one? Point at the element to match (the Revit Mark tool, R4)`); continue; }
      if (f?.category && /^structural (framing|columns|foundations)$/i.test(f.category)) { ask.push(`${q}: a structural section is an engineer's decision (rule 5)`); continue; }
      if (f?.types?.length) {
        const exact = f.types.filter((t) => t.toLowerCase() === name.toLowerCase());
        const words = name.toLowerCase().split(/\s+/).filter(Boolean);
        const has = exact.length ? exact : f.types.filter((t) => words.every((w) => t.toLowerCase().includes(w)));
        if (has.length !== 1) { unclear.push(`${q}: ${has.length ? `which type: ${has.join(", ")}?` : `no type "${name}" is loaded for this family (${f.types.slice(0, 8).join(", ")})`}`); continue; }
        name = has[0];
      }
      if (f?.type_name && f.type_name.toLowerCase() === name.toLowerCase()) { notes.push(`It is already ${name}`); continue; }
      push({ op: "change_type", type_name: name, ...(f?.type_name ? { was: f.type_name } : {}), sentence: `Change the type to ${name}${f?.type_name ? ` (now ${f.type_name})` : f?.types?.length ? "" : " (check the type is loaded: planned without the family's types)"}` });
      continue;
    }

    if (i.kind === "material") {
      const m = i.material ? materials.find((x) => x.toLowerCase() === i.material!.toLowerCase()) : undefined;
      if (!m) { unclear.push(`${q}: ${i.why ?? (i.material ? `${i.material} isn't in the kit's material list: a kit change request (rule 7)` : "which kit material?")}`); continue; }
      push({ op: "set_material", material: m, sentence: `Give ${what} the kit material ${m}` });
      continue;
    }

    if (i.kind === "delete") { push({ op: "delete", sentence: `Delete ${what}` }); continue; }

    if (i.kind === "add_clearance") {
      if (i.value_mm === undefined) { unclear.push(`${q}: the clearance size comes from the kit's rules for ${f?.category ?? "this element"}, never from code (rule 7)`); continue; }
      push({ op: "add_clearance", value_mm: i.value_mm, sentence: `Show a ${fmt(i.value_mm)} clearance zone at ${what}` });
      continue;
    }
  }

  const parts = [`${steps.length} step${steps.length === 1 ? "" : "s"}`];
  if (unclear.length) parts.push(`${unclear.length} unclear`);
  if (ask.length) parts.push(`${ask.length} for an engineer`);
  if (notes.length) parts.push(`${notes.length} already done`);
  const summary = parts.join(", ") + (f ? "" : "; planned from the note alone (no element facts from Revit)");
  return { dry_run: true, ready: !!f && steps.length > 0 && !unclear.length && !ask.length, steps, unclear, ask_engineer: ask, notes, from_note_only: !f, summary };
}
