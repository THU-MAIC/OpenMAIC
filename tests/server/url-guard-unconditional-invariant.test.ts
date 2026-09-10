/**
 * Repo-wide invariant: `validateUrlForSSRF` runs at every call site in every
 * environment.
 *
 * The guard itself owns the documented self-hosting escape hatch
 * (`ALLOW_LOCAL_NETWORKS`), so a route-level `process.env.NODE_ENV` condition
 * around a call is always redundant: outside a production build it silently
 * disables the check. That gate was once applied at several API routes from a
 * hand-written list that drifted from the code. This test makes the gap
 * un-reintroducible: it walks the repository source, finds every
 * `validateUrlForSSRF` call site, and fails if any call site sits inside an
 * `if` block whose condition references `NODE_ENV`. The failure names the
 * offending file and line so the reintroduction is caught at review time, not
 * in production.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** Directories that are not repository source (deps, build output, fixtures). */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.codegraph',
  '.turbo',
  '.vercel',
  '.cache',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'data',
  'public',
  'assets',
]);

/**
 * Return every call occurrence as a 1-based line number. The definition in
 * ssrf-guard.ts matches too and is fine: it is never gated.
 */
function findCallLines(content: string): number[] {
  const lines: number[] = [];
  const callPattern = /validateUrlForSSRF\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(content)) !== null) {
    let line = 1;
    for (let i = 0; i < match.index; i++) {
      if (content[i] === '\n') line += 1;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Replace string/comment/regex-literal bodies with spaces (keeping length and
 * newlines) so brace and parenthesis matching only ever sees structure.
 */
function blankLiterals(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          out += '  ';
          i += 2;
          break;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out += ' ';
          i += 1;
          break;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && /[^/]/.test(next ?? '')) {
      // Heuristic regex literal: skip to the next unescaped `/` on the same
      // line. Regexes cannot span lines without flags, so this is safe enough
      // for structural scanning.
      out += ' ';
      i += 1;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (source[i] === '/') {
          out += ' ';
          i += 1;
          break;
        }
        out += ' ';
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Walk from an opening `(` to its matching `)` and return the end index. */
function matchingParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Find every `if (...)` block whose condition references `NODE_ENV` and return
 * the 1-based line ranges of their braced bodies. Mirrors the historical gate
 * shape (`if (x && process.env.NODE_ENV === 'production') { ... }`) as well as
 * inverted `!== 'production'` variants and single-statement bodies.
 */
function findNodeEnvGuardedBodyLines(source: string): Set<number> {
  const guarded = new Set<number>();
  const text = blankLiterals(source);
  const ifPattern = /\bif\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = ifPattern.exec(text)) !== null) {
    const openParen = text.indexOf('(', match.index);
    const closeParen = matchingParen(text, openParen);
    if (closeParen === -1) continue;
    // Read the condition from the ORIGINAL text so `NODE_ENV` is recognized in
    // every spelling (dot or bracket access), not only where it is not inside
    // a literal.
    const condition = source.slice(match.index, closeParen + 1);
    if (!/\bNODE_ENV\b/.test(condition)) continue;

    // Skip whitespace and any comment residue (already blanked) to the body.
    let body = closeParen + 1;
    while (body < text.length && /\s/.test(text[body])) body += 1;

    const bodyStart = body;
    let bodyEnd = -1;
    if (text[body] === '{') {
      let depth = 0;
      for (let i = body; i < text.length; i++) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            bodyEnd = i;
            break;
          }
        }
      }
    } else {
      // Single-statement body: ends at the first `;` on this construct.
      const semicolon = text.indexOf(';', body);
      bodyEnd = semicolon === -1 ? text.length - 1 : semicolon;
    }

    if (bodyEnd === -1) continue;
    const firstLine = lineOfIndex(text, bodyStart);
    const lastLine = lineOfIndex(text, bodyEnd);
    for (let line = firstLine; line <= lastLine; line++) guarded.add(line);
  }
  return guarded;
}

/** Map a character index back to its 1-based line number. */
function lineOfIndex(content: string, index: number): number {
  let line = 1;
  const end = Math.min(index, content.length - 1);
  for (let i = 0; i < end; i++) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry)) files.push(...collectSourceFiles(full));
    } else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
      files.push(full);
    }
  }
  return files;
}

describe('validateUrlForSSRF call sites are never gated by NODE_ENV', () => {
  it('finds no call site inside a NODE_ENV-conditional block in the repository source', () => {
    const offenders: string[] = [];
    const scanned: string[] = [];
    let callSites = 0;

    for (const file of collectSourceFiles(ROOT)) {
      const rel = relative(ROOT, file);
      if (rel === 'tests/server/url-guard-unconditional-invariant.test.ts') continue;
      scanned.push(rel);
      const content = readFileSync(file, 'utf-8');
      const callLines = findCallLines(content);
      if (callLines.length === 0) continue;
      callSites += callLines.length;
      const guardedLines = findNodeEnvGuardedBodyLines(content);
      for (const callLine of callLines) {
        if (guardedLines.has(callLine)) {
          offenders.push(`${rel}:${callLine}`);
        }
      }
    }

    expect(scanned.length).toBeGreaterThan(500);
    expect(callSites).toBeGreaterThanOrEqual(30);
    expect(offenders).toEqual([]);
  });
});
