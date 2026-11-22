/**
 * Reject a send_code_to_revit script before it reaches Revit.
 * A stack overflow cannot be caught in .NET, and an endless loop holds Revit's API thread until Revit is closed.
 * The size limit is script_max_chars in fmc_guard.json (default 1_000_000, the same cap the tool already documents).
 */
import { loadConfig } from "./policy.js";

export const DEFAULT_SCRIPT_MAX_CHARS = 1_000_000;

export interface ScriptProblem {
  code: "FMC-CODE-TOO-LARGE" | "FMC-CODE-RECURSION" | "FMC-CODE-LOOP" | "FMC-SEND-CODE-UNSCOPED";
  message: string;
}

export interface ScreenOptions {
  /** allow_full_scan on send_code_to_revit. The unscoped parameter walk is still a crash risk. */
  allowFullScan?: boolean;
}

const KEYWORDS = new Set([
  "if", "else", "while", "for", "foreach", "do", "switch", "using", "lock", "catch", "fixed", "when",
  "return", "throw", "new", "sizeof", "typeof", "nameof", "default", "checked", "unchecked", "get", "set",
  "add", "remove", "async", "await", "base", "this",
]);

export function scriptLimit(): number {
  const raw = loadConfig().config.script_max_chars;
  const n = Math.floor(Number(raw ?? DEFAULT_SCRIPT_MAX_CHARS));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SCRIPT_MAX_CHARS;
}

export function screenScript(code: string, maxChars = DEFAULT_SCRIPT_MAX_CHARS, opts?: ScreenOptions): ScriptProblem | null {
  if (code.length > maxChars) {
    return {
      code: "FMC-CODE-TOO-LARGE",
      message: `[FMC-CODE-TOO-LARGE] The script has ${code.length.toLocaleString("en")} characters; the limit is ${maxChars.toLocaleString("en")}. ` +
        `Fix: split it into smaller scripts, each one send_code_to_revit call under ${maxChars.toLocaleString("en")} characters. Nothing was sent to Revit.`,
    };
  }
  const masked = maskLiterals(code);
  const recursion = findRecursion(masked);
  if (recursion) return recursion;
  const loop = findLoop(masked);
  if (loop) return loop;
  if (opts?.allowFullScan) return null;
  return findUnscopedParameterScan(masked);
}

/** Comments and string literals become spaces. Newlines stay so line numbers match the script. */
export function maskLiterals(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) {
        out += code[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < code.length) { out += "  "; i += 2; }
      continue;
    }
    if (c === "@" && next === "\"") {
      out += "  ";
      i += 2;
      while (i < code.length) {
        if (code[i] === "\"" && code[i + 1] === "\"") { out += "  "; i += 2; continue; }
        if (code[i] === "\"") { out += " "; i++; break; }
        out += code[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    if (c === "\"") {
      out += " ";
      i++;
      while (i < code.length) {
        if (code[i] === "\\") { out += "  "; i += 2; continue; }
        if (code[i] === "\"") { out += " "; i++; break; }
        out += code[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    if (c === "'") {
      out += " ";
      i++;
      if (code[i] === "\\") { out += "  "; i += 2; }
      while (i < code.length && code[i] !== "'") { out += code[i] === "\n" ? "\n" : " "; i++; }
      if (i < code.length) { out += " "; i++; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

function isIdent(c: string | undefined): boolean {
  return !!c && /[A-Za-z0-9_]/.test(c);
}

function isWord(src: string, index: number, word: string): boolean {
  if (!src.startsWith(word, index)) return false;
  if (index > 0 && isIdent(src[index - 1])) return false;
  return !isIdent(src[index + word.length]);
}

function matchForward(src: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchBack(src: string, close: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (src[i] === closeCh) depth++;
    else if (src[i] === openCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function wordBefore(src: string, index: number): string {
  let i = index - 1;
  while (i >= 0 && /\s/.test(src[i])) i--;
  let end = i + 1;
  while (i >= 0 && isIdent(src[i])) i--;
  return src.slice(i + 1, end);
}

interface FnRange { name: string; nameAt: number; body: string }

function functionsIn(src: string): FnRange[] {
  const found: FnRange[] = [];
  const re = /(?<![\w.?])([A-Za-z_]\w*)\s*(?:<[^<>]*>)?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src))) {
    const name = match[1];
    if (KEYWORDS.has(name)) continue;
    const before = src.slice(Math.max(0, match.index - 8), match.index);
    if (/\bnew\s*$/.test(before)) continue;
    const paren = src.indexOf("(", match.index);
    const close = matchForward(src, paren, "(", ")");
    if (close < 0) continue;
    let i = close + 1;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.startsWith("where", i) && !isIdent(src[i + 5])) {
      const brace = src.indexOf("{", i);
      if (brace < 0) continue;
      i = brace;
    }
    if (src[i] === "{") {
      const end = matchForward(src, i, "{", "}");
      if (end < 0) continue;
      found.push({ name, nameAt: match.index, body: src.slice(i + 1, end) });
      continue;
    }
    if (src[i] === "=" && src[i + 1] === ">") {
      const expr = readExpression(src, i + 2);
      found.push({ name, nameAt: match.index, body: expr });
    }
  }
  return found;
}

function readExpression(src: string, start: number): string {
  let paren = 0;
  let brace = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if (c === "{") brace++;
    else if (c === "}") {
      if (brace === 0) break;
      brace--;
    } else if (c === ";" && paren === 0 && brace === 0) break;
    i++;
  }
  return src.slice(start, i);
}

function callsItself(name: string, body: string): boolean {
  const re = new RegExp("(?<![\\w.?])" + name + "\\s*(?:<[^<>]*>)?\\s*\\(", "g");
  return re.test(body);
}

/** A conditional or a loop is a stop. A bare call of the same method is not. */
function hasStop(body: string): boolean {
  if (/\b(if|switch|foreach|for|while|do)\b/.test(body)) return true;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "?") continue;
    const next = body[i + 1];
    if (next === "?" || next === "." || next === ">") continue;
    return true;
  }
  return false;
}

function findRecursion(src: string): ScriptProblem | null {
  for (const fn of functionsIn(src)) {
    if (!callsItself(fn.name, fn.body) || hasStop(fn.body)) continue;
    const line = lineOf(src, fn.nameAt);
    return {
      code: "FMC-CODE-RECURSION",
      message: `[FMC-CODE-RECURSION] ${fn.name} calls itself (line ${line}). A stack overflow cannot be caught and crashes Revit. ` +
        `Fix: do not call ${fn.name} from itself. Use a loop with a limit, or an explicit stack, and stop at a known depth. Nothing was sent to Revit.`,
    };
  }
  return null;
}

function readStatement(src: string, start: number): string {
  let i = start;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === "{") {
    const end = matchForward(src, i, "{", "}");
    return end < 0 ? src.slice(i + 1) : src.slice(i + 1, end);
  }
  if (src[i] === ";") return "";
  const from = i;
  if (isWord(src, i, "if") || isWord(src, i, "for") || isWord(src, i, "foreach") || isWord(src, i, "while") || isWord(src, i, "lock") || isWord(src, i, "using") || isWord(src, i, "switch")) {
    const paren = src.indexOf("(", i);
    const close = paren < 0 ? -1 : matchForward(src, paren, "(", ")");
    if (close >= 0) return src.slice(from, close + 1) + readStatement(src, close + 1);
  }
  if (isWord(src, i, "do")) {
    const brace = src.indexOf("{", i);
    const end = brace < 0 ? -1 : matchForward(src, brace, "{", "}");
    return end < 0 ? src.slice(from) : src.slice(from, end + 1);
  }
  let paren = 0;
  let brace = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if (c === "{") brace++;
    else if (c === "}") {
      if (brace === 0) break;
      brace--;
    } else if (c === ";" && paren === 0 && brace === 0) break;
    i++;
  }
  return src.slice(from, i);
}

function braceKind(src: string, braceIndex: number): "loop" | "switch" | "function" | "other" {
  let i = braceIndex - 1;
  while (i >= 0 && /\s/.test(src[i])) i--;
  if (i < 0) return "other";
  if (isWord(src, i - 1, "do") || src.slice(Math.max(0, i - 1), i + 1) === "do") return "loop";
  if (src[i] !== ")") return "other";
  const open = matchBack(src, i, "(", ")");
  if (open < 0) return "other";
  const word = wordBefore(src, open);
  if (word === "while" || word === "for" || word === "foreach") return "loop";
  if (word === "switch") return "switch";
  if (!word || KEYWORDS.has(word)) return "other";
  const pre = wordBefore(src, open - word.length);
  if (pre === "new") return "other";
  return "function";
}

/** return, throw, goto, or a break that belongs to this loop (not a nested loop, switch, or local function). */
function hasDirectExit(body: string): boolean {
  const stack: Array<"loop" | "switch" | "function" | "other"> = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{") { stack.push(braceKind(body, i)); continue; }
    if (c === "}") { stack.pop(); continue; }
    const nestedFn = stack.includes("function");
    if (!nestedFn && (isWord(body, i, "return") || isWord(body, i, "throw") || isWord(body, i, "goto"))) return true;
    if (!nestedFn && isWord(body, i, "break") && !stack.includes("loop") && !stack.includes("switch")) return true;
  }
  return false;
}

function conditionOf(header: string): string {
  return header.replace(/\s+/g, "");
}

const SCOPED_COLLECTOR = /OfClass\s*\(|OfCategory\s*\(|OfCategoryId\s*\(|ElementClassFilter|ElementCategoryFilter|ElementMulticlassFilter/;
const PARAMETER_DUMP = /\.Parameters\b|\.ParametersMap\b|GetOrderedParameters\s*\(/;
const PARAMETER_READ = /\.StorageType\b|AsValueString\s*\(/;

/**
 * Revit 2025.4 died with AccessViolationException in Parameter.get_StorageType while a read_only script
 * walked every parameter of every element. .NET 8 cannot catch that. A collector with no category or class,
 * together with a full parameter enumeration that reads StorageType or AsValueString, is refused.
 */
function findUnscopedParameterScan(src: string): ScriptProblem | null {
  if (!PARAMETER_DUMP.test(src) || !PARAMETER_READ.test(src)) return null;
  if (!iteratesUnscopedCollector(src)) return null;
  return {
    code: "FMC-SEND-CODE-UNSCOPED",
    message: "[FMC-SEND-CODE-UNSCOPED] This script walks every parameter of every element: a FilteredElementCollector with no category or class filter, then Parameters, GetOrderedParameters or ParametersMap, reading StorageType or AsValueString. " +
      "That walk crashed Revit 2025.4 (AccessViolationException in Parameter.get_StorageType). .NET cannot catch it. " +
      "Fix: scope the collector with OfCategory or OfClass, and read named parameters with LookupParameter or get_Parameter(BuiltInParameter), in batches. " +
      "Pass allow_full_scan true only when a full scan is really meant. Nothing was sent to Revit.",
  };
}

function iteratesUnscopedCollector(src: string): boolean {
  const re = /new\s+FilteredElementCollector\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src))) {
    const built = collectorExpr(src, match.index);
    const name = assignedName(src, match.index);
    const later = name ? variableTail(src, name, built.end) : "";
    const whole = built.expr + later;
    if (SCOPED_COLLECTOR.test(whole)) continue;
    if (collectorIterated(src, match.index, built.expr) || (name ? variableIterated(src, name, built.end) : false)) return true;
  }
  return false;
}

function collectorExpr(src: string, at: number): { expr: string; end: number } {
  const paren = src.indexOf("(", at);
  const close = paren < 0 ? -1 : matchForward(src, paren, "(", ")");
  if (close < 0) return { expr: src.slice(at), end: src.length };
  let i = close + 1;
  while (i < src.length) {
    let j = i;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== ".") break;
    j++;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (!/[A-Za-z_]/.test(src[j] ?? "")) break;
    while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === "<") {
      const endGen = src.indexOf(">", j);
      if (endGen < 0) break;
      j = endGen + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
    }
    if (src[j] !== "(") break;
    const end = matchForward(src, j, "(", ")");
    if (end < 0) break;
    i = end + 1;
  }
  return { expr: src.slice(at, i), end: i };
}

function assignedName(src: string, at: number): string | undefined {
  const back = src.slice(Math.max(0, at - 160), at);
  const named = /([A-Za-z_]\w*)\s*=\s*$/.exec(back);
  if (!named || KEYWORDS.has(named[1]) || named[1] === "return" || named[1] === "new") return undefined;
  return named[1];
}

function variableTail(src: string, name: string, from: number): string {
  const re = new RegExp("(?<![\\w.])" + name + "\\s*\\.", "g");
  re.lastIndex = from;
  let out = "";
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(src))) out += src.slice(hit.index, Math.min(src.length, hit.index + 120));
  return out;
}

function collectorIterated(src: string, at: number, expr: string): boolean {
  if (/\.\s*(ToElements|ToElementIds|GetElementIterator|Cast)\s*(<|\()/.test(expr)) return true;
  const before = src.slice(Math.max(0, at - 100), at).replace(/\s+/g, " ");
  return /\bforeach\s*\(/.test(before) && /\bin\s*$/.test(before);
}

function variableIterated(src: string, name: string, from: number): boolean {
  const re = new RegExp("(?<![\\w.])" + name + "\\b", "g");
  re.lastIndex = from;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(src))) {
    const after = src.slice(hit.index + name.length, hit.index + name.length + 40);
    if (/^\s*\.\s*(ToElements|ToElementIds|GetElementIterator|Cast)\b/.test(after)) return true;
    const before = src.slice(Math.max(0, hit.index - 30), hit.index).replace(/\s+/g, " ");
    if (/\bin\s*$/.test(before)) return true;
  }
  return false;
}

function findLoop(src: string): ScriptProblem | null {
  for (let i = 0; i < src.length; i++) {
    const isWhile = isWord(src, i, "while");
    const isFor = !isWhile && isWord(src, i, "for");
    if (!isWhile && !isFor) continue;
    const paren = src.indexOf("(", i);
    if (paren < 0 || paren - i > 12) continue;
    const close = matchForward(src, paren, "(", ")");
    if (close < 0) continue;
    const header = src.slice(paren + 1, close);
    const flat = conditionOf(header);
    let kind = "";
    if (isWhile && (flat === "true" || flat === "1")) kind = "while(true)";
    if (isFor) {
      const parts = header.split(";").map((part) => part.trim());
      if (parts.length === 3 && (parts[1] === "" || parts[1] === "true" || parts[1] === "1")) kind = "for(;;)";
    }
    const body = readStatement(src, close + 1);
    if (kind && !hasDirectExit(body)) {
      return {
        code: "FMC-CODE-LOOP",
        message: `[FMC-CODE-LOOP] ${kind} at line ${lineOf(src, i)} has no break, return or throw. It would hold Revit until Revit is closed. ` +
          `Fix: add a break when the work is done, or a counter that stops the loop (if (++n > 1000) break;). Nothing was sent to Revit.`,
      };
    }
    i = close;
  }
  return null;
}
