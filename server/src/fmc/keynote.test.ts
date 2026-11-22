import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { explain } from "./explain.js";
import { screenScript } from "./scriptguard.js";
import { batchHasExtent, MODIFY_MODEL_DESCRIPTION, MODEL_EDIT_OPS } from "../tools/modify_element.js";
import {
  KEYNOTE_SCRIPT, classifyKeynoteBatch, executeKeynoteBatch, keynoteCall, shapeKeynoteResult, validateKeynoteOps,
} from "./keynote.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const tag = { op: "tag", mode: "keynote_element", view: "A201", ids: [15, 16], tag_type: "M_Keynote Tag: Keynote Text", leader: true };

test("a keynote batch is its own call; a mix and a for_each are refused before Revit", async () => {
  assert.equal(classifyKeynoteBatch([tag]), "keynote");
  assert.equal(classifyKeynoteBatch([{ op: "create_wall" }]), "model");
  assert.equal(classifyKeynoteBatch([tag, { op: "text", view: "A201", text: "note" }]), "mixed");
  assert.equal(classifyKeynoteBatch([{ op: "for_each", per: "room", ops: [tag] }]), "for_each");
  const calls: string[] = [];
  const send = async (command: string) => { calls.push(command); return {}; };
  const mixed = await executeKeynoteBatch([tag, { op: "text" }], false, "Ogala", send);
  assert.equal(mixed?.isError, true);
  assert.match(String(mixed?.body.reason), /their own modify_model call/);
  const each = await executeKeynoteBatch([{ op: "for_each", ops: [tag] }], false, "Ogala", send);
  assert.match(String(each?.body.reason), /for_each/);
  assert.equal(await executeKeynoteBatch([{ op: "create_wall" }], false, "Ogala", send), null);
  assert.deepEqual(calls, []);
});

test("keynote ops are checked before a script is sent", () => {
  assert.match(validateKeynoteOps([{ op: "tag", mode: "keynote_user", view: "A201", ids: [1] }]) ?? "", /needs key/);
  assert.match(validateKeynoteOps([{ op: "tag", mode: "keynote_element", view: "A201" }]) ?? "", /ids or select/);
  assert.match(validateKeynoteOps([{ op: "place_schedule", sheet: "A201", schedule: "KN" }]) ?? "", /point_mm/);
  assert.equal(validateKeynoteOps([tag, { op: "keynote_legend", name: "A201 Keynotes", filtered_by_sheet: true },
    { op: "place_schedule", sheet: "$2", schedule: "A201 Keynotes", point_mm: [20, 280] }]), null);
});

test("the bridge script sets Key Source and keeps a tag only when it reads back", async () => {
  const call = keynoteCall([tag, { op: "keynote_legend", name: "A201 Keynotes", filtered_by_sheet: true },
    { op: "place_schedule", sheet: "A201", schedule: "$2", point_mm: [20, 280] }], true, "Ogala Residence");
  assert.equal(screenScript(call.code), null);
  assert.match(KEYNOTE_SCRIPT, /SetInternal/);
  assert.match(KEYNOTE_SCRIPT, /KEY_SOURCE_PARAM/);
  assert.match(KEYNOTE_SCRIPT, /AsValueString/);
  assert.match(KEYNOTE_SCRIPT, /document\.Delete\(tag\.Id\)/);
  assert.match(KEYNOTE_SCRIPT, /CreateKeynoteLegend/);
  assert.match(KEYNOTE_SCRIPT, /IsFilteredBySheet = true/);
  assert.match(KEYNOTE_SCRIPT, /ScheduleSheetInstance\.Create/);
  assert.doesNotMatch(KEYNOTE_SCRIPT, /ExportImage|picture/);
  const payload = JSON.parse(String((call.params.parameters as string[])[0]));
  assert.equal(payload.dry_run, true);
  assert.equal(payload.ops[0].one_per_key, true);
  assert.equal(payload.ops[0].leader, true);
  assert.equal(payload.ops[0].mode, "keynote_element");
  assert.equal(payload.ops[1].filtered_by_sheet, true);
  assert.equal(call.params.transactionMode, "read_only");
  assert.equal(call.params.dry_run, true);
  assert.equal(call.params.document, "Ogala Residence");
  const lines = explain("send_code_to_revit", call.params);
  assert.match(lines[0], /Dry run/);
  assert.match(lines[1], /Keynote tag \(Element\) in A201/);
  assert.match(lines[2], /Keynote legend "A201 Keynotes", filtered by sheet/);
  assert.match(lines[3], /Place \$2 on sheet A201/);
  assert.ok(lines.every((line) => !line.includes("SetInternal")));
  const real = keynoteCall([{ op: "tag", mode: "keynote_material", view: "A201", ids: [4], leader: false, one_per_key: false }], false);
  assert.equal(real.params.transactionMode, "auto");
  assert.equal(JSON.parse(String((real.params.parameters as string[])[0])).ops[0].leader, false);
});

test("select is resolved, then one script runs, and the answer is counts without a picture", async () => {
  const sent: Array<{ command: string; params: Record<string, unknown> }> = [];
  const out = await executeKeynoteBatch(
    [{ op: "tag", mode: "keynote_element", view: "A201", select: { category: "Walls" }, ids: [15], tag_type: "FMC_TAG_Keynote: Key" }],
    false,
    "A-0002",
    async (command, params) => {
      sent.push({ command, params });
      if (command === "fmc_select_by") return { ids: [15, 20] };
      return {
        success: true,
        undoId: "3a0112",
        document: { title: "A-0002", path: "Z:\\Ogala\\A-0002.rvt" },
        result: {
          applied: true,
          ops: [{
            kind: "tag", mode: "keynote_element", tagged: 1, created_ids: [88],
            skipped: [{ id: 20, key: "A.WAL_01", reason: "key already tagged in this view" }],
            counts: { created: 1, skipped: 1 },
          }],
          note: "kept",
        },
      };
    },
  );
  assert.deepEqual(sent.map((call) => call.command), ["fmc_select_by", "send_code_to_revit"]);
  assert.equal((sent[0].params as { category?: string }).category, "Walls");
  const payload = JSON.parse(String((sent[1].params.parameters as string[])[0]));
  assert.deepEqual(payload.ops[0].ids, [15, 20]);
  assert.equal(out?.isError, false);
  assert.equal(out?.body.applied, true);
  assert.equal(out?.body.batch_id, "3a0112");
  assert.equal((out?.body.document as { title: string }).title, "A-0002");
  const op = (out?.body.ops as Array<Record<string, unknown>>)[0];
  assert.deepEqual(op.counts, { created: 1, skipped: 1 });
  assert.deepEqual(op.created_ids, [88]);
  assert.equal((op.skipped as Array<{ reason: string }>)[0].reason, "key already tagged in this view");
  assert.equal(batchHasExtent([{ op: "tag" }, { op: "keynote_legend" }, { op: "place_schedule" }]), false);
  assert.ok(MODEL_EDIT_OPS.includes("keynote_legend") && MODEL_EDIT_OPS.includes("place_schedule"));
  assert.match(MODIFY_MODEL_DESCRIPTION, /keynote_element/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /place_schedule/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /create_stair/);
});

test("a rolled-back script is an error and does not claim the model changed", () => {
  const shaped = shapeKeynoteResult({ success: false, errorCode: "FMC-CODE-RUNTIME", errorMessage: "no view A201" }, false);
  assert.equal(shaped.isError, true);
  assert.equal(shaped.body.applied, false);
  assert.equal(shaped.body.rolled_back, true);
  assert.match(String(shaped.body.reason), /no view A201/);
});

test("an omitted tag type prefers FMC_TAG_Keynote_v2 Key Value, and a blank tag is not called shown", () => {
  assert.match(KEYNOTE_SCRIPT, /FMC_TAG_Keynote_v2/);
  assert.match(KEYNOTE_SCRIPT, /string\.Equals\(f\.Name, "Key Value"/);
  assert.match(KEYNOTE_SCRIPT, /M_Keynote Tag/);
  assert.match(KEYNOTE_SCRIPT, /GetDefaultFamilyTypeId/);
  const elementKey = KEYNOTE_SCRIPT.slice(KEYNOTE_SCRIPT.indexOf("string ElementKey"));
  assert.match(elementKey, /TextKey\(type\)[\s\S]{0,80}return TextKey\(e\)/);
  assert.match(KEYNOTE_SCRIPT, /KeynoteTable\.GetKeynoteTable\(document\)/);
  assert.match(KEYNOTE_SCRIPT, /GetKeyBasedTreeEntries/);
  assert.match(KEYNOTE_SCRIPT, /skipped_empty_keynote/);
  assert.match(KEYNOTE_SCRIPT, /\["type_name"\] = typeName/);
  assert.match(KEYNOTE_SCRIPT, /key_not_in_table/);
  assert.match(KEYNOTE_SCRIPT, /tag\.TagText/);
  assert.match(KEYNOTE_SCRIPT, /\["blank"\] = blank/);
  assert.match(KEYNOTE_SCRIPT, /\["tag_id"\] = tag\.Id\.Value/);
  assert.match(KEYNOTE_SCRIPT, /\["skipped_empty_keynote"\] = emptyKey/);
  assert.match(KEYNOTE_SCRIPT, /\["key_not_in_table"\] = notInTable/);
  assert.match(KEYNOTE_SCRIPT, /TagText was empty after placement/);
  assert.match(KEYNOTE_SCRIPT, /shownCount = created\.Count - blank\.Count/);
  assert.match(KEYNOTE_SCRIPT, /\["shown"\] = shownCount/);
  assert.match(KEYNOTE_SCRIPT, /document\.Delete\(tag\.Id\)/);
  assert.doesNotMatch(KEYNOTE_SCRIPT, /while\s*\(\s*true\s*\)/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /FMC_TAG_Keynote_v2/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /skipped_empty_keynote/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /key_not_in_table/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /TagText/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /Key Value/);
  const bare = keynoteCall([{ op: "tag", mode: "keynote_material", view: "A201", ids: [4] }], true, "Ogala");
  assert.equal(screenScript(bare.code), null);
  const payload = JSON.parse(String((bare.params.parameters as string[])[0]));
  assert.equal(payload.ops[0].tag_type, undefined);
  assert.equal(payload.ops[0].mode, "keynote_material");
  const lines = explain("send_code_to_revit", bare.params);
  assert.match(lines.join("\n"), /FMC_TAG_Keynote_v2: Key Value if loaded/);
  const user = keynoteCall([{ op: "tag", mode: "keynote_user", view: "A201", ids: [9], key: "A.WAL_01" }], false);
  assert.match(user.code, /KeynoteTable\.GetKeynoteTable/);
  assert.equal(JSON.parse(String((user.params.parameters as string[])[0])).ops[0].key, "A.WAL_01");
});

test("keynote mode source declares no identifier twice across nested scopes", () => {
  // The checker has to see the collision this fix removes, or a broken checker would pass the real script.
  const nested = "if (true) { string shown = \"x\"; }\nint shown = 1;\n";
  assert.ok(duplicateDeclarations(nested).some((problem) => problem.startsWith("CS0136") && problem.includes("shown")));
  for (const mode of ["keynote_element", "keynote_material", "keynote_user"] as const) {
    for (const dryRun of [true, false]) {
      const call = keynoteCall([{
        op: "tag", mode, view: "E-0001", ids: [1],
        ...(mode === "keynote_user" ? { key: "A.WAL_01" } : {}),
      }], dryRun, "F26901");
      const problems = duplicateDeclarations(call.code);
      assert.deepEqual(problems, [], problems.join("\n"));
      assert.match(call.code, /\["skipped_empty_keynote"\] = emptyKey/);
      assert.match(call.code, /\["key_not_in_table"\] = notInTable/);
      assert.match(call.code, /\["blank"\] = blank/);
      assert.match(call.code, /\["shown"\] = shownCount/);
      assert.match(call.code, /\["counts"\] = new JObject/);
      assert.equal(call.params.dry_run, dryRun);
    }
  }
});

test("FMC_TAG_Keynote is built from the Keynote Tag template with Key and Key+Text", () => {
  const spec = fs.readFileSync(path.join(root, "scripts", "kitbuild", "annotation", "tags_spec.py"), "utf8");
  const line = spec.split("\n").find((row) => row.includes('fam("FMC_TAG_Keynote"'));
  assert.ok(line, "FMC_TAG_Keynote is declared in tags_spec.py");
  assert.match(line!, /Metric Keynote Tag\.rft/);
  assert.doesNotMatch(line!, /Generic Tag/);
  assert.match(line!, /\["Key", "Key\+Text"\]/);
  assert.match(spec, /Show_Key": \[1, 1\], "Show_Text": \[0, 1\]/);
});

// CS0136: a local is in scope for its whole block, so a nested declaration of the same name collides even when the
// outer one is written later. CS0128 is two declarations in one block. Revit reports both as FMC-CODE-COMPILE.
// There is no C# compiler in the server test job, so this reads the generated source.

interface Tok { text: string; line: number }
interface Decl { name: string; line: number }
interface Block { decls: Decl[]; stmts: Stmt[] }
interface Stmt { type: "block" | "extra"; block: Block; extra?: Decl[]; before?: Stmt[] }
interface ExprOpt { comma: boolean; patterns?: Decl[] }

const STMT = new Set(["if", "else", "foreach", "for", "while", "do", "try", "catch", "finally", "return", "throw", "break", "continue", "switch", "using", "lock"]);

function maskScript(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (src[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("//", i)) {
      const end = src.indexOf("\n", i);
      const to = end < 0 ? src.length : end;
      blank(i, to);
      i = to;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      const to = end < 0 ? src.length : end + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (src.startsWith("@\"", i)) {
      let j = i + 2;
      while (j < src.length) {
        if (src[j] === "\"" && src[j + 1] === "\"") { j += 2; continue; }
        if (src[j] === "\"") { j++; break; }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (src[i] === "\"") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "\"") { j++; break; }
        if (src[j] === "\n") break;
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (src[i] === "'") {
      let j = i + 1;
      if (src[j] === "\\") j += 2;
      else j += 1;
      if (src[j] === "'") j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return out.join("");
}

function tokenize(masked: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  let line = 1;
  const two = ["=>", "??", "?.", ">=", "<=", "==", "!=", "&&", "||", "+=", "-=", "*=", "/=", "++", "--"];
  while (i < masked.length) {
    const c = masked[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    const pair = masked.slice(i, i + 2);
    if (two.includes(pair)) { tokens.push({ text: pair, line }); i += 2; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < masked.length && /[A-Za-z0-9_]/.test(masked[j])) j++;
      tokens.push({ text: masked.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(masked.slice(i));
      const text = m ? m[0] : c;
      tokens.push({ text, line });
      i += text.length;
      continue;
    }
    tokens.push({ text: c, line });
    i++;
  }
  return tokens;
}

class ScriptParser {
  tokens: Tok[];
  i = 0;
  paren = 0;
  brace = 0;
  bracket = 0;
  constructor(tokens: Tok[]) { this.tokens = tokens; }
  peek(n = 0): Tok { return this.tokens[this.i + n] ?? { text: "", line: this.tokens.at(-1)?.line ?? 1 }; }
  more(): boolean { return this.i < this.tokens.length; }
  is(text: string): boolean { return this.peek().text === text; }
  isIdent(tok?: Tok): boolean { return /^[A-Za-z_]/.test((tok ?? this.peek()).text); }
  eat(): Tok {
    const tok = this.tokens[this.i++];
    if (!tok) throw new Error("unexpected end of script");
    return tok;
  }
  expect(text: string): Tok {
    if (!this.is(text)) throw new Error(`line ${this.peek().line}: expected ${text} near ${this.peek().text || "end"}`);
    return this.eat();
  }
  expectIdent(): Tok {
    if (!this.isIdent()) throw new Error(`line ${this.peek().line}: expected a name near ${this.peek().text || "end"}`);
    return this.eat();
  }
  declOf(tok: Tok): Decl { return { name: tok.text, line: tok.line }; }
  empty(): Block { return { decls: [], stmts: [] }; }
  parseScript(): Block {
    const block = this.empty();
    while (this.more()) this.parseStatement(block);
    return block;
  }
  parseBlock(): Block {
    this.expect("{");
    const block = this.empty();
    while (this.more() && !this.is("}")) this.parseStatement(block);
    this.expect("}");
    return block;
  }
  parseBlockOrStatement(): Block {
    if (this.is("{")) return this.parseBlock();
    const block = this.empty();
    this.parseStatement(block);
    return block;
  }
  parseStatement(block: Block): void {
    const start = this.i;
    if (!this.more()) return;
    if (this.is(";")) { this.eat(); return; }
    if (this.is("{")) { block.stmts.push({ type: "block", block: this.parseBlock() }); return; }
    if (this.is("if")) { this.parseIf(block); return; }
    if (this.is("foreach")) { this.parseForeach(block); return; }
    if (this.is("for")) { this.parseFor(block); return; }
    if (this.is("while")) { this.parseWhile(block); return; }
    if (this.is("try")) { this.parseTry(block); return; }
    if (this.is("return") || this.is("throw")) {
      this.eat();
      if (!this.is(";")) this.skipExpression(block, { comma: false });
      this.expect(";");
      return;
    }
    if (this.is("break") || this.is("continue")) { this.eat(); this.expect(";"); return; }
    if (this.looksLikeDeclaration()) { this.parseDeclaration(block); return; }
    this.skipExpression(block, { comma: false });
    this.expect(";");
    if (this.i === start) throw new Error(`parser did not advance at line ${this.peek().line}`);
  }
  parseIf(block: Block): void {
    this.eat();
    this.expect("(");
    this.paren++;
    const cond = this.empty();
    const patterns: Decl[] = [];
    this.skipExpression(cond, { comma: false, patterns });
    this.expect(")");
    this.paren--;
    const body = this.parseBlockOrStatement();
    block.stmts.push({ type: "extra", extra: patterns, block: body, before: cond.stmts });
    if (this.is("else")) {
      this.eat();
      block.stmts.push({ type: "block", block: this.parseBlockOrStatement() });
    }
  }
  parseForeach(block: Block): void {
    this.eat();
    this.expect("(");
    this.paren++;
    if (!this.parseType()) throw new Error(`line ${this.peek().line}: foreach type`);
    const name = this.expectIdent();
    this.expect("in");
    const expr = this.empty();
    this.skipExpression(expr, { comma: false });
    this.expect(")");
    this.paren--;
    const body = this.parseBlockOrStatement();
    block.stmts.push(...expr.stmts);
    block.stmts.push({ type: "extra", extra: [this.declOf(name)], block: body, before: [] });
  }
  parseFor(block: Block): void {
    this.eat();
    this.expect("(");
    this.paren++;
    const init = this.empty();
    const extras: Decl[] = [];
    if (!this.is(";")) {
      if (this.looksLikeDeclaration()) this.parseDeclarators(init, extras);
      else this.skipExpression(init, { comma: false });
    }
    this.expect(";");
    if (!this.is(";")) this.skipExpression(init, { comma: false });
    this.expect(";");
    if (!this.is(")")) this.skipExpression(init, { comma: false });
    this.expect(")");
    this.paren--;
    const body = this.parseBlockOrStatement();
    block.stmts.push({ type: "extra", extra: extras, block: body, before: init.stmts });
  }
  parseWhile(block: Block): void {
    this.eat();
    this.expect("(");
    this.paren++;
    this.skipExpression(block, { comma: false });
    this.expect(")");
    this.paren--;
    block.stmts.push({ type: "block", block: this.parseBlockOrStatement() });
  }
  parseTry(block: Block): void {
    this.eat();
    block.stmts.push({ type: "block", block: this.parseBlockOrStatement() });
    while (this.is("catch")) {
      this.eat();
      const extra: Decl[] = [];
      if (this.is("(")) {
        this.eat();
        if (!this.is(")")) {
          if (!this.parseType()) throw new Error(`line ${this.peek().line}: catch type`);
          if (this.isIdent() && !this.is(")")) extra.push(this.declOf(this.eat()));
        }
        this.expect(")");
      }
      const body = this.parseBlockOrStatement();
      block.stmts.push({ type: "extra", extra, block: body, before: [] });
    }
    if (this.is("finally")) {
      this.eat();
      block.stmts.push({ type: "block", block: this.parseBlockOrStatement() });
    }
  }
  parseDeclaration(block: Block): void {
    if (this.is("ref")) this.eat();
    if (!this.parseType()) throw new Error(`line ${this.peek().line}: type`);
    const name = this.expectIdent();
    if (this.is("(")) {
      const params = this.parseParams();
      const body = this.is("{") ? this.parseBlock() : this.expressionBlock();
      block.decls.push(this.declOf(name));
      block.stmts.push({ type: "extra", extra: params, block: body, before: [] });
      return;
    }
    this.parseDeclarators(block, [], name);
    this.expect(";");
  }
  parseDeclarators(block: Block, extras: Decl[], first?: Tok): void {
    let name = first ?? null;
    if (!name) {
      if (this.is("ref")) this.eat();
      if (!this.parseType()) throw new Error(`line ${this.peek().line}: type`);
      name = this.expectIdent();
    }
    const decl = this.declOf(name);
    extras.push(decl);
    block.decls.push(decl);
    if (this.is("=")) { this.eat(); this.skipExpression(block, { comma: true }); }
    while (this.is(",")) {
      this.eat();
      const next = this.declOf(this.expectIdent());
      block.decls.push(next);
      extras.push(next);
      if (this.is("=")) { this.eat(); this.skipExpression(block, { comma: true }); }
    }
  }
  expressionBlock(): Block {
    this.expect("=>");
    const block = this.empty();
    this.skipExpression(block, { comma: false });
    this.expect(";");
    return block;
  }
  parseParams(): Decl[] {
    this.expect("(");
    const params: Decl[] = [];
    if (!this.is(")")) {
      do {
        if (this.is(",")) this.eat();
        if (["out", "ref", "in", "params"].includes(this.peek().text)) this.eat();
        if (!this.parseType()) throw new Error(`line ${this.peek().line}: parameter type near ${this.peek().text}`);
        params.push(this.declOf(this.expectIdent()));
      } while (this.is(","));
    }
    this.expect(")");
    return params;
  }
  looksLikeDeclaration(): boolean {
    const save = this.i;
    if (this.is("ref")) this.i++;
    if (!this.parseType()) { this.i = save; return false; }
    if (!this.isIdent() || STMT.has(this.peek().text)) { this.i = save; return false; }
    const after = this.peek(1).text;
    const ok = after === "(" || after === "=" || after === "," || after === ";";
    this.i = save;
    return ok;
  }
  parseType(): boolean {
    if (!this.isIdent()) return false;
    this.eat();
    while (this.is(".") && this.isIdent(this.peek(1))) { this.eat(); this.eat(); }
    if (this.is("<")) {
      this.eat();
      if (!this.parseType()) return false;
      while (this.is(",")) { this.eat(); if (!this.parseType()) return false; }
      if (!this.is(">")) return false;
      this.eat();
    }
    while (this.is("[") && this.peek(1).text === "]") { this.eat(); this.eat(); }
    if (this.is("?")) this.eat();
    return true;
  }
  skipExpression(sink: Block, opt: ExprOpt): void {
    const floorP = this.paren;
    const floorB = this.brace;
    const floorK = this.bracket;
    while (this.more()) {
      const t = this.peek().text;
      const atFloor = this.paren === floorP && this.brace === floorB && this.bracket === floorK;
      if (atFloor && (t === ";" || t === ")" || t === "]" || t === "}" || (opt.comma && t === ","))) break;
      if (this.isIdent() && this.peek(1).text === "=>") { this.parseLambda(sink); continue; }
      if (t === "(" && this.parenLambdaAhead()) { this.parseParenLambda(sink); continue; }
      if (opt.patterns && t === "is") { this.parsePattern(opt.patterns); continue; }
      if (t === "(") { this.paren++; this.eat(); continue; }
      if (t === ")") { this.paren--; this.eat(); continue; }
      if (t === "{") { this.brace++; this.eat(); continue; }
      if (t === "}") { this.brace--; this.eat(); continue; }
      if (t === "[") { this.bracket++; this.eat(); continue; }
      if (t === "]") { this.bracket--; this.eat(); continue; }
      this.eat();
    }
  }
  parsePattern(patterns: Decl[]): void {
    this.eat();
    if (!this.parseType()) return;
    if (this.isIdent() && !STMT.has(this.peek().text) && this.peek(1).text !== "(" && this.peek(1).text !== "<" && this.peek(1).text !== ".") {
      const next = this.peek(1).text;
      if ([")", "&&", "||", "?", ":", ";", ",", "]", "}"].includes(next) || next === "") patterns.push(this.declOf(this.eat()));
    }
  }
  parseLambda(sink: Block): void {
    const name = this.eat();
    this.eat();
    const body = this.is("{") ? this.parseBlock() : this.lambdaExpr();
    sink.stmts.push({ type: "extra", extra: [this.declOf(name)], block: body, before: [] });
  }
  lambdaExpr(): Block {
    const block = this.empty();
    this.skipExpression(block, { comma: true });
    return block;
  }
  parseParenLambda(sink: Block): void {
    const params: Decl[] = [];
    this.eat();
    if (!this.is(")")) {
      do {
        if (this.is(",")) this.eat();
        const save = this.i;
        if (this.parseType() && this.isIdent() && [",", ")", "="].includes(this.peek(1).text)) params.push(this.declOf(this.eat()));
        else { this.i = save; params.push(this.declOf(this.expectIdent())); }
      } while (this.is(","));
    }
    this.expect(")");
    this.expect("=>");
    const body = this.is("{") ? this.parseBlock() : this.lambdaExpr();
    sink.stmts.push({ type: "extra", extra: params, block: body, before: [] });
  }
  parenLambdaAhead(): boolean {
    let depth = 0;
    for (let k = this.i; k < this.tokens.length; k++) {
      const t = this.tokens[k]?.text;
      if (t === "(") depth++;
      else if (t === ")") { depth--; if (depth === 0) return this.tokens[k + 1]?.text === "=>"; }
      else if (depth === 0) return false;
    }
    return false;
  }
}

function checkBlock(block: Block, enclosing: Map<string, number>, problems: string[]): void {
  const here = new Map<string, number>();
  for (const d of block.decls) {
    if (here.has(d.name)) problems.push(`CS0128 ${d.name} declared twice in the same scope (lines ${here.get(d.name)} and ${d.line})`);
    else if (enclosing.has(d.name)) problems.push(`CS0136 ${d.name} at line ${d.line} is declared in a nested scope; an enclosing scope declares it at line ${enclosing.get(d.name)}`);
    else here.set(d.name, d.line);
  }
  const child = new Map(enclosing);
  for (const [name, line] of here) child.set(name, line);
  for (const stmt of block.stmts) checkStmt(stmt, child, problems);
}

function checkStmt(stmt: Stmt, enclosing: Map<string, number>, problems: string[]): void {
  if (stmt.type === "block") { checkBlock(stmt.block, enclosing, problems); return; }
  const here = new Map<string, number>();
  for (const d of stmt.extra ?? []) {
    if (here.has(d.name)) problems.push(`CS0128 ${d.name} declared twice in the same scope (lines ${here.get(d.name)} and ${d.line})`);
    else if (enclosing.has(d.name)) problems.push(`CS0136 ${d.name} at line ${d.line} is declared in a nested scope; an enclosing scope declares it at line ${enclosing.get(d.name)}`);
    else here.set(d.name, d.line);
  }
  const next = new Map(enclosing);
  for (const [name, line] of here) next.set(name, line);
  for (const before of stmt.before ?? []) checkStmt(before, next, problems);
  checkBlock(stmt.block, next, problems);
}

function duplicateDeclarations(source: string): string[] {
  try {
    const tokens = tokenize(maskScript(source));
    const parser = new ScriptParser(tokens);
    const block = parser.parseScript();
    const problems: string[] = [];
    if (parser.i < tokens.length) {
      const t = tokens[parser.i];
      problems.push(`parser stopped at line ${t?.line ?? "?"} near ${t?.text || "end"}`);
    }
    checkBlock(block, new Map(), problems);
    return problems;
  } catch (err) {
    return [`the scope check could not read the script: ${err instanceof Error ? err.message : String(err)}`];
  }
}
