import { Script } from 'node:vm';

export interface InteractiveScriptSyntaxFailure {
  readonly scriptIndex: number;
  readonly message: string;
}

const CLASSIC_JAVASCRIPT_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);

/**
 * Elements whose contents are not parsed as HTML when scripting is enabled.
 * A `<script>` byte sequence inside them is text, not an executable element.
 * `title` and `textarea` are RCDATA; the rest are raw text. Both hide tags.
 */
const UNPARSED_TEXT_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'style',
  'textarea',
  'title',
  'xmp',
]);

interface HtmlTag {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  /** Index immediately after this tag's closing `>`. */
  readonly end: number;
}

interface ScriptElement {
  readonly attributes: ReadonlyMap<string, string>;
  readonly source: string;
  /** False inside `<template>`: those scripts do not run until cloned. */
  readonly executable: boolean;
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f';
}

function isAsciiAlpha(char: string | undefined): boolean {
  return char !== undefined && ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z'));
}

function startsTagName(html: string, open: number): boolean {
  let index = open + 1;
  if (html[index] === '/') index += 1;
  return isAsciiAlpha(html[index]);
}

/**
 * Parse one start or end tag beginning at `open` (`<`).
 * Quoted attribute values may contain `>`; the tag ends at the `>` that is
 * not inside quotes. Returns null when the tag never closes.
 */
function parseTag(html: string, open: number): HtmlTag | null {
  let index = open + 1;
  if (index >= html.length) return null;
  if (html[index] === '/') index += 1;
  if (!isAsciiAlpha(html[index])) return null;

  const nameStart = index;
  index += 1;
  while (index < html.length) {
    const char = html[index]!;
    if (isWhitespace(char) || char === '/' || char === '>') break;
    index += 1;
  }
  const name = html.slice(nameStart, index).toLowerCase();
  const attributes = new Map<string, string>();

  while (index < html.length) {
    const char = html[index]!;
    if (isWhitespace(char) || char === '/') {
      index += 1;
      continue;
    }
    if (char === '>') return { name, attributes, end: index + 1 };

    const attrStart = index;
    while (index < html.length) {
      const attrChar = html[index]!;
      if (isWhitespace(attrChar) || attrChar === '/' || attrChar === '>' || attrChar === '=') {
        break;
      }
      index += 1;
    }
    if (index === attrStart) {
      index += 1;
      continue;
    }
    const attrName = html.slice(attrStart, index).toLowerCase();
    while (index < html.length && isWhitespace(html[index]!)) index += 1;

    let value = '';
    if (index < html.length && html[index] === '=') {
      index += 1;
      while (index < html.length && isWhitespace(html[index]!)) index += 1;
      if (index >= html.length) return null;
      const quote = html[index]!;
      if (quote === '"' || quote === "'") {
        const valueStart = index + 1;
        const valueEnd = html.indexOf(quote, valueStart);
        if (valueEnd === -1) return null;
        value = html.slice(valueStart, valueEnd);
        index = valueEnd + 1;
      } else {
        const valueStart = index;
        while (index < html.length && !isWhitespace(html[index]!) && html[index] !== '>') {
          index += 1;
        }
        value = html.slice(valueStart, index);
      }
    }
    if (!attributes.has(attrName)) attributes.set(attrName, value);
  }

  return null;
}

/** HTML comment starting at `<!--`. The first `-->` is not always the end (`<!-->`). */
function skipComment(html: string, open: number): number {
  let index = open + 4;
  let state: 'start' | 'data' | 'end' = 'start';

  while (index < html.length) {
    const char = html[index]!;
    if (state === 'start') {
      if (char === '>') return index + 1;
      if (char === '-') {
        index += 1;
        if (index >= html.length) return html.length;
        if (html[index] === '>') return index + 1;
        if (html[index] === '-') {
          index += 1;
          state = 'end';
          continue;
        }
      }
      index += 1;
      state = 'data';
      continue;
    }

    if (state === 'data') {
      if (char !== '-') {
        index += 1;
        continue;
      }
      index += 1;
      if (index < html.length && html[index] === '-') {
        index += 1;
        state = 'end';
      }
      continue;
    }

    if (char === '>') return index + 1;
    if (char === '-') {
      index += 1;
      continue;
    }
    if (char === '!') {
      index += 1;
      if (index >= html.length) return html.length;
      if (html[index] === '>') return index + 1;
      if (html[index] === '-') {
        index += 1;
        if (index < html.length && html[index] === '-') {
          index += 1;
          continue;
        }
      }
      state = 'data';
      continue;
    }
    index += 1;
    state = 'data';
  }

  return html.length;
}

function matchNamedEndTag(html: string, open: number, expectedName: string): HtmlTag | null {
  if (html[open] !== '<' || html[open + 1] !== '/') return null;
  const tag = parseTag(html, open);
  if (!tag || tag.name !== expectedName) return null;
  return tag;
}

function skipUnparsedText(html: string, start: number, name: string): number {
  if (name === 'plaintext') return html.length;
  let index = start;
  while (index < html.length) {
    const lessThan = html.indexOf('<', index);
    if (lessThan === -1) return html.length;
    const endTag = matchNamedEndTag(html, lessThan, name);
    if (endTag) return endTag.end;
    index = lessThan + 1;
  }
  return html.length;
}

function readScriptData(html: string, start: number): { source: string; end: number } {
  let index = start;
  while (index < html.length) {
    const lessThan = html.indexOf('<', index);
    if (lessThan === -1) return { source: html.slice(start), end: html.length };
    const endTag = matchNamedEndTag(html, lessThan, 'script');
    if (endTag) return { source: html.slice(start, lessThan), end: endTag.end };
    index = lessThan + 1;
  }
  return { source: html.slice(start), end: html.length };
}

/**
 * Script elements in source order, using HTML tokenization rules.
 * Comments, raw/RCDATA text, and attribute values do not contribute scripts.
 */
function extractScriptElements(html: string): ScriptElement[] {
  const scripts: ScriptElement[] = [];
  let index = 0;
  let templateDepth = 0;

  while (index < html.length) {
    const lessThan = html.indexOf('<', index);
    if (lessThan === -1) break;
    index = lessThan;

    if (html.startsWith('<!--', index)) {
      index = skipComment(html, index);
      continue;
    }

    if (html.startsWith('<!', index) || html.startsWith('<?', index)) {
      const greaterThan = html.indexOf('>', index + 2);
      index = greaterThan === -1 ? html.length : greaterThan + 1;
      continue;
    }

    const endTag = html[index + 1] === '/';
    if (endTag && !isAsciiAlpha(html[index + 2])) {
      if (html[index + 2] === '>') {
        index += 3;
        continue;
      }
      const greaterThan = html.indexOf('>', index + 2);
      index = greaterThan === -1 ? html.length : greaterThan + 1;
      continue;
    }

    const tag = parseTag(html, index);
    if (!tag) {
      // An unclosed tag runs to EOF. A bare `<` that is not a tag is text.
      if (startsTagName(html, index)) break;
      index += 1;
      continue;
    }

    if (endTag) {
      if (tag.name === 'template' && templateDepth > 0) templateDepth -= 1;
      index = tag.end;
      continue;
    }

    if (tag.name === 'template') {
      templateDepth += 1;
      index = tag.end;
      continue;
    }

    if (tag.name === 'plaintext') break;

    if (UNPARSED_TEXT_ELEMENTS.has(tag.name)) {
      index = skipUnparsedText(html, tag.end, tag.name);
      continue;
    }

    if (tag.name === 'script') {
      const body = readScriptData(html, tag.end);
      scripts.push({
        attributes: tag.attributes,
        source: body.source,
        executable: templateDepth === 0,
      });
      index = body.end;
      continue;
    }

    index = tag.end;
  }

  return scripts;
}

function classicScriptType(attributes: ReadonlyMap<string, string>): string {
  const raw = (attributes.get('type') ?? '').trim().toLowerCase();
  // MIME parameters (`text/javascript; charset=utf-8`) are not part of the type.
  return raw.split(';', 1)[0]!.trim();
}

function isExecutableClassicInline(script: ScriptElement): boolean {
  if (!script.executable || script.attributes.has('src')) return false;
  return CLASSIC_JAVASCRIPT_TYPES.has(classicScriptType(script.attributes));
}

function classicScriptSyntaxError(source: string): string | null {
  try {
    // Compile as a classic Script. Never run the result.
    new Script(source);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Parse-check classic inline scripts without executing them.
 *
 * The grammar is a classic Script, not a FunctionBody: top-level `return` is
 * a syntax error. `node:vm` `Script` compiles only; the result is never run.
 *
 * Data scripts, external scripts, and module scripts are skipped. `scriptIndex`
 * counts every parsed `<script>` element, including ones that are skipped.
 * Scripts HTML would not execute — comments, unparsed text, attributes, and
 * `<template>` — are not checked. Template scripts are still counted.
 */
export function findInteractiveScriptSyntaxFailure(
  html: string,
): InteractiveScriptSyntaxFailure | null {
  const scripts = extractScriptElements(html);
  for (let index = 0; index < scripts.length; index += 1) {
    const script = scripts[index]!;
    if (!isExecutableClassicInline(script) || !script.source.trim()) continue;
    const message = classicScriptSyntaxError(script.source);
    if (message) return { scriptIndex: index + 1, message };
  }
  return null;
}
