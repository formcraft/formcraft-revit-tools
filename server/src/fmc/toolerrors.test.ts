import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolFailure } from "../tools/failure.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.resolve(here, here.includes(`${path.sep}build${path.sep}`) ? "../../src/tools" : "../tools");

test("toolFailure is a real MCP error", () => {
  const r = toolFailure("get available family types failed: no document");
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "get available family types failed: no document");
});

/**
 * A catch that returns the error text as an ordinary tool result is reported to the caller as success.
 * Every such return has to go through toolFailure (isError: true) or set isError itself.
 */
test("every tool catch that returns a result marks the failure", () => {
  const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith(".ts") && f !== "register.ts");
  assert.ok(files.length >= 80, `expected the tool directory, found ${files.length} at ${toolsDir}`);
  const problems: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(toolsDir, file), "utf8");
    for (const body of catchBodies(src)) {
      const returnsContent = /return\s*\{[\s\S]*\bcontent\s*:/.test(body);
      const returnsFailureText = /return\s+(?:reply|text)\(\s*\{[^}]*\berror\b/.test(body) || /toolFailure\s*\(/.test(body);
      if (!returnsContent && !returnsFailureText) continue;
      const marked = /isError\s*:\s*true/.test(body) || /toolFailure\s*\(/.test(body) || /,\s*true\s*\)/.test(body);
      if (!marked) problems.push(`${file}: a catch returns a result without isError: true`);
    }
  }
  assert.deepEqual(problems, []);
});

function catchBodies(src: string): string[] {
  const out: string[] = [];
  const re = /catch\s*(\([^)]*\))?\s*\{/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(src))) {
    const open = hit.index + hit[0].length - 1;
    const close = matchingBrace(src, open);
    if (close < 0) break;
    out.push(src.slice(open, close + 1));
    re.lastIndex = close + 1;
  }
  return out;
}

function matchingBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
    else if (c === "`") {
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "`") break;
        if (src[i] === "$" && src[i + 1] === "{") {
          const inner = matchingBrace(src, i + 1);
          if (inner < 0) return -1;
          i = inner;
        }
        i++;
      }
    } else if (c === "\"" || c === "'") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
    }
  }
  return -1;
}
