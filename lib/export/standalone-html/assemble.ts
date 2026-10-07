/**
 * Pure assembly of the standalone HTML export: one document carrying the
 * precompiled player (script + style), the classroom manifest and the player
 * config. No IO, no DOM; the impure collection lives in `build-standalone-html.ts`.
 */
import type { ClassroomManifest } from '../classroom-zip-types';
import {
  STANDALONE_CONFIG_ELEMENT_ID,
  STANDALONE_MANIFEST_ELEMENT_ID,
  STANDALONE_ROOT_ELEMENT_ID,
  type StandalonePlayerConfig,
} from './contract';

/**
 * Content Security Policy of the exported file.
 *
 * Nothing may be fetched: every source is inline or a `data:`/`blob:` URL, and
 * `connect-src 'none'` blocks fetch/XHR/WebSocket. Interactive scenes render in
 * `srcdoc` iframes, which inherit this policy, so the script allowances below
 * also cover authored interactive pages (inline scripts, inlined `data:`
 * modules, and the `eval` some of their libraries rely on). Those pages still
 * run in an opaque origin: the sandbox never grants `allow-same-origin`.
 *
 * Because `'unsafe-inline'` applies to the player's own document as well, the
 * CSP is not what keeps authored content from running there: slide rich text,
 * which the renderer injects as HTML, is sanitized before it is embedded (see
 * `prepare-manifest.ts`), and quiz and PBL text is rendered as text.
 */
export const STANDALONE_HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data:",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  'frame-src data: blob:',
  'worker-src data: blob:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * Serialize a value for a `<script type="application/json">` block.
 *
 * `<`, `>` and `&` are written as JSON unicode escapes, so no `</script>`,
 * `<!--` or `<script` sequence can appear in the raw text and end (or
 * re-enter) the element early; U+2028/U+2029 are escaped for good measure.
 * `JSON.parse` on the element's text restores the exact original strings.
 */
export function serializeJsonForHtmlScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Escape text for an HTML text node or a double-quoted attribute. */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Raw-text payloads (the player script and styles) cannot be escaped without
 * changing their meaning, so they are checked instead: the build step emits
 * them free of these sequences, and a payload that is not is refused rather
 * than allowed to break out of its element. A bare `<script` is harmless in
 * script data unless an earlier `<!--` switched the parser into its escaped
 * state, so `<!--` is the sequence refused for scripts.
 */
function assertRawText(payload: string, element: 'script' | 'style', label: string): string {
  const closing = new RegExp(`</${element}`, 'i');
  if (closing.test(payload) || (element === 'script' && payload.includes('<!--'))) {
    throw new Error(
      `Standalone HTML: ${label} contains a sequence that would end its <${element}>`,
    );
  }
  return payload;
}

export interface StandaloneHtmlInput {
  /** The classroom manifest, already prepared for offline playback. */
  manifest: ClassroomManifest;
  config: StandalonePlayerConfig;
  /** Precompiled player bundle (an IIFE). */
  playerScript: string;
  /** Precompiled player + renderer CSS. */
  playerStyle: string;
  /** Additional style sheets appended after the player CSS (e.g. math fonts). */
  extraStyles?: readonly string[];
  /** Additional scripts run before the player (e.g. the charts runtime). */
  extraScripts?: readonly string[];
  /** BCP 47 language tag of the player UI. */
  lang: string;
}

/** Assemble the complete standalone document. */
export function assembleStandaloneHtml(input: StandaloneHtmlInput): string {
  const title = input.manifest.stage.name || 'Classroom';
  const styles = [input.playerStyle, ...(input.extraStyles ?? [])]
    .map(
      (css, index) => `<style>${assertRawText(css, 'style', `style sheet ${index + 1}`)}</style>`,
    )
    .join('\n');
  return [
    '<!doctype html>',
    `<html lang="${escapeHtmlText(input.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${STANDALONE_HTML_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="OpenMAIC">',
    `<title>${escapeHtmlText(title)}</title>`,
    styles,
    '</head>',
    '<body>',
    `<div id="${STANDALONE_ROOT_ELEMENT_ID}"></div>`,
    `<script type="application/json" id="${STANDALONE_MANIFEST_ELEMENT_ID}">${serializeJsonForHtmlScript(input.manifest)}</script>`,
    `<script type="application/json" id="${STANDALONE_CONFIG_ELEMENT_ID}">${serializeJsonForHtmlScript(input.config)}</script>`,
    ...(input.extraScripts ?? []).map(
      (js, index) => `<script>${assertRawText(js, 'script', `script ${index + 1}`)}</script>`,
    ),
    `<script>${assertRawText(input.playerScript, 'script', 'player script')}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
