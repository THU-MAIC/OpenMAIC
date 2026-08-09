/**
 * JSON parsing with fallback strategies for AI-generated responses.
 */

import { jsonrepair } from 'jsonrepair';
import { createLogger } from '@/lib/logger';
const log = createLogger('Generation');

function repairQuotedPropertyFragments(jsonStr: string): string {
  return jsonStr.replace(
    /([,{]\s*)"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(true|false|null|[+-]?\d+(?:\.\d+)?)"(?=\s*[,}])/g,
    (_match, prefix, key, value) => `${prefix}"${key}": ${value}`,
  );
}

/**
 * LaTeX command names that begin with a JSON control-escape letter (n/r/t) and
 * therefore collide with `\n` `\r` `\t`. Used by
 * {@link normalizeJsonStringBackslashes} to tell e.g. `\nu` / `\times` (LaTeX)
 * apart from a genuine newline / tab escape. The list is intentionally limited
 * to common math commands; an unlisted command simply keeps the previous
 * behaviour (no regression) — it does not break parsing.
 */
const NRT_LATEX_COMMANDS = new Set([
  // \n…
  'nu',
  'nabla',
  'neq',
  'ne',
  'ni',
  'not',
  'notin',
  'nleq',
  'ngeq',
  'nless',
  'ngtr',
  'nmid',
  'nparallel',
  'nsubseteq',
  'nsupseteq',
  'nsim',
  'ncong',
  'nearrow',
  'nwarrow',
  'nexists',
  'neg',
  'natural',
  'nrightarrow',
  'nleftarrow',
  'nleftrightarrow',
  'nprec',
  'nsucc',
  // \r…
  'rho',
  'right',
  'rightarrow',
  'rightleftharpoons',
  'rightharpoonup',
  'rightharpoondown',
  'rangle',
  'rceil',
  'rfloor',
  'rbrace',
  'rbrack',
  'rtimes',
  'rvert',
  'rmoustache',
  // \t…
  'theta',
  'times',
  'tau',
  'tan',
  'tanh',
  'text',
  'textbf',
  'textit',
  'textrm',
  'texttt',
  'textstyle',
  'tfrac',
  'tbinom',
  'therefore',
  'tilde',
  'to',
  'top',
  'tag',
  'triangle',
  'triangledown',
  'triangleleft',
  'triangleright',
  'triangleq',
  'tt',
]);

/**
 * Re-escape stray backslashes inside JSON string literals so that raw LaTeX
 * (which LLMs frequently emit) survives `JSON.parse`.
 *
 * Why this is needed: `JSON.parse` does not throw on `"\frac"` or `"\times"` —
 * it silently decodes `\f` -> U+000C (form feed) and `\t` -> U+0009 (tab),
 * corrupting the math content. Sequences whose command starts with a letter
 * that is not a valid escape (`\sum`, `\alpha`) make `JSON.parse` throw instead,
 * so the previous regex fixes only ever saw that second class and left the
 * silent corruption in place. Normalising here, before the first parse, closes
 * both paths with a single linear scan (no catastrophic backtracking).
 *
 * The function is a strict no-op on already-valid JSON: every valid escape
 * (`\"` `\\` `\/` `\n` `\r` `\t` `\uXXXX`) is preserved, including newlines that
 * precede a lowercase word and tabs inside code. The only deliberate
 * reinterpretation is a bare `\b` / `\f` followed by letters — a
 * backspace / form-feed reading never occurs in real educational content,
 * whereas `\beta` / `\frac` are ubiquitous, so those are read as LaTeX.
 */
export function normalizeJsonStringBackslashes(jsonStr: string): string {
  // Fast path: no backslash means no escapes to normalise, so the scan below
  // would be a pure copy. Most structure-heavy JSON hits this.
  if (!jsonStr.includes('\\')) return jsonStr;

  let out = '';
  let inString = false;
  let i = 0;
  while (i < jsonStr.length) {
    const ch = jsonStr[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      i += 1;
      continue;
    }
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    // `ch` is a backslash inside a string literal.
    const next = jsonStr[i + 1];
    if (next === undefined) {
      out += '\\\\';
      i += 1;
      continue;
    }
    // Valid pass-through escapes.
    if (next === '"' || next === '\\' || next === '/') {
      out += '\\' + next;
      i += 2;
      continue;
    }
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(jsonStr.slice(i + 2, i + 6))) {
      out += jsonStr.slice(i, i + 6);
      i += 6;
      continue;
    }
    // `\b` / `\f`: a control reading never appears in content -> LaTeX command.
    if (next === 'b' || next === 'f') {
      out += '\\\\' + next;
      i += 2;
      continue;
    }
    // `\n` / `\r` / `\t`: a genuine control escape UNLESS the maximal lowercase
    // run spells a known LaTeX command (`\nu`, `\rho`, `\times`, ...).
    if (next === 'n' || next === 'r' || next === 't') {
      let j = i + 1;
      while (j < jsonStr.length && jsonStr[j] >= 'a' && jsonStr[j] <= 'z') j += 1;
      const run = jsonStr.slice(i + 1, j);
      if (NRT_LATEX_COMMANDS.has(run)) {
        out += '\\\\' + run;
        i = j;
        continue;
      }
      out += '\\' + next;
      i += 2;
      continue;
    }
    // Any other char is not a valid JSON escape: a LaTeX command letter
    // (`\sum`, `\alpha`, `\Gamma`), a `\u` that is not `\uXXXX` (`\underline`),
    // or LaTeX punctuation (`\%`, `\_`, `\{`). Double-escape to keep the literal
    // backslash.
    out += '\\\\' + next;
    i += 2;
  }
  return out;
}

function logJsonParseError(stage: string, jsonStr: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const positionMatch = message.match(/position\s+(\d+)/i);
  const position = positionMatch ? Number(positionMatch[1]) : undefined;

  if (typeof position === 'number' && Number.isFinite(position)) {
    const start = Math.max(0, position - 120);
    const end = Math.min(jsonStr.length, position + 120);
    log.warn(
      `${stage} parse error at position ${position}: ${message}. Context: ${jsonStr
        .slice(start, end)
        .replace(/\n/g, '\\n')}`,
    );
    return;
  }

  log.warn(`${stage} parse error: ${message}`);
}

export function parseJsonResponse<T>(response: string): T | null {
  const exactParsed = tryParseExactJson<T>(response);
  if (exactParsed !== null) return exactParsed;

  const cleanedResponse = stripReasoningPrefix(response);
  if (cleanedResponse !== response.trim()) {
    const parsedCleaned = parseJsonResponseCandidate<T>(cleanedResponse);
    if (parsedCleaned !== null) return parsedCleaned;
  }

  const parsed = parseJsonResponseCandidate<T>(response);
  if (parsed !== null) return parsed;

  log.error('Failed to parse JSON from response');
  log.error('Raw response (first 500 chars):', cleanedResponse.substring(0, 500));
  log.error(
    'Raw response (last 500 chars):',
    cleanedResponse.substring(Math.max(0, cleanedResponse.length - 500)),
  );

  return null;
}

function tryParseExactJson<T>(response: string): T | null {
  try {
    return JSON.parse(response.trim()) as T;
  } catch {
    return null;
  }
}

function stripReasoningPrefix(response: string): string {
  const trimmed = response.trim();
  const matches = [...trimmed.matchAll(/<\/(?:think|thinking|reasoning)>\s*/gi)];
  const lastMatch = matches.at(-1);

  if (!lastMatch || lastMatch.index === undefined) return trimmed;

  return trimmed.slice(lastMatch.index + lastMatch[0].length).trim();
}

function parseJsonResponseCandidate<T>(response: string): T | null {
  const cleanedResponse = response.trim();

  // Strategy 1: Try to extract JSON from markdown code blocks (may have multiple)
  const codeBlockMatches = cleanedResponse.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
  for (const match of codeBlockMatches) {
    const extracted = match[1].trim();
    // Only try if it looks like JSON (starts with { or [)
    if (extracted.startsWith('{') || extracted.startsWith('[')) {
      const result = tryParseJson<T>(extracted);
      if (result !== null) {
        log.debug('Successfully parsed JSON from code block');
        return result;
      }
    }
  }

  // Strategy 2: Try to find JSON structure directly in response (no code block)
  // Look for array or object start
  const jsonStartArray = cleanedResponse.indexOf('[');
  const jsonStartObject = cleanedResponse.indexOf('{');

  if (jsonStartArray !== -1 || jsonStartObject !== -1) {
    // Prefer the structure that appears first
    const startIndex =
      jsonStartArray === -1
        ? jsonStartObject
        : jsonStartObject === -1
          ? jsonStartArray
          : Math.min(jsonStartArray, jsonStartObject);

    // Find the matching close bracket
    let depth = 0;
    let endIndex = -1;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < cleanedResponse.length; i++) {
      const char = cleanedResponse[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '[' || char === '{') depth++;
        else if (char === ']' || char === '}') {
          depth--;
          if (depth === 0) {
            endIndex = i;
            break;
          }
        }
      }
    }

    if (endIndex !== -1) {
      const jsonStr = cleanedResponse.substring(startIndex, endIndex + 1);
      const result = tryParseJson<T>(jsonStr);
      if (result !== null) {
        log.debug('Successfully parsed JSON from response body');
        return result;
      }
    }
  }

  // Strategy 3: Last resort - try the whole response
  const result = tryParseJson<T>(cleanedResponse.trim());
  if (result !== null) {
    log.debug('Successfully parsed raw response as JSON');
    return result;
  }

  return null;
}

/**
 * Try to parse JSON with various fixes for common AI response issues
 */
export function tryParseJson<T>(jsonStr: string): T | null {
  // Attempt 1: Normalise stray LaTeX backslashes, then parse.
  // This runs before any plain parse because JSON.parse silently mis-decodes
  // raw LaTeX (`\frac` -> form feed, `\times` -> tab) instead of throwing;
  // normalisation is a no-op on already-valid JSON.
  try {
    return JSON.parse(normalizeJsonStringBackslashes(jsonStr)) as T;
  } catch (error) {
    logJsonParseError('Attempt 1', jsonStr, error);
    // Continue to fix attempts
  }

  // Attempt 2: Fix common JSON issues from AI responses
  try {
    let fixed = jsonStr;

    // Fix 0: Recover malformed property fragments that were accidentally
    // emitted as standalone strings inside an object, such as:
    // `"height: 76"` -> `"height": 76`
    // `"fixedRatio: false"` -> `"fixedRatio": false`
    // The object-context prefix/suffix guards keep valid JSON strings intact.
    fixed = repairQuotedPropertyFragments(fixed);

    // Fix 1: Re-escape raw LaTeX backslashes (`\frac`, `\times`, `\sum`, ...) so
    // the math content survives JSON.parse. See normalizeJsonStringBackslashes
    // for the full rationale; it supersedes the previous per-letter regex fixes
    // which left `\b\f\n\r\t`-initial commands silently corrupted.
    fixed = normalizeJsonStringBackslashes(fixed);

    // Fix 3: Try to fix truncated JSON arrays/objects
    const trimmed = fixed.trim();
    if (trimmed.startsWith('[') && !trimmed.endsWith(']')) {
      const lastCompleteObj = fixed.lastIndexOf('}');
      if (lastCompleteObj > 0) {
        fixed = fixed.substring(0, lastCompleteObj + 1) + ']';
        log.warn('Fixed truncated JSON array');
      }
    } else if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
      // Try to close incomplete object
      const openBraces = (fixed.match(/{/g) || []).length;
      const closeBraces = (fixed.match(/}/g) || []).length;
      if (openBraces > closeBraces) {
        fixed += '}'.repeat(openBraces - closeBraces);
        log.warn('Fixed truncated JSON object');
      }
    }

    return JSON.parse(fixed) as T;
  } catch (error) {
    logJsonParseError('Attempt 2', jsonStr, error);
    // Continue to next attempt
  }

  // Attempt 3: Use jsonrepair to fix malformed JSON (e.g. unescaped quotes in Chinese text)
  try {
    const repaired = jsonrepair(jsonStr);
    return JSON.parse(repaired) as T;
  } catch (error) {
    logJsonParseError('Attempt 3', jsonStr, error);
    // Continue to next attempt
  }

  // Attempt 4: More aggressive fixing - remove control characters
  try {
    let fixed = jsonStr;

    // Remove or escape control characters
    fixed = fixed.replace(/[\x00-\x1F\x7F]/g, (char) => {
      switch (char) {
        case '\n':
          return '\\n';
        case '\r':
          return '\\r';
        case '\t':
          return '\\t';
        default:
          return '';
      }
    });

    return JSON.parse(fixed) as T;
  } catch (error) {
    logJsonParseError('Attempt 4', jsonStr, error);
    return null;
  }
}
