/**
 * Pure assembly of the standalone HTML export: one document carrying the
 * precompiled player (script + style), the classroom manifest and the player
 * config. No IO, no DOM; the impure collection lives in `build-standalone-html.ts`.
 */
import type { ClassroomManifest } from '../classroom-zip-types';
import {
  STANDALONE_CONFIG_ELEMENT_ID,
  STANDALONE_MANIFEST_ELEMENT_ID,
  STANDALONE_MEDIA_BLOCK_ID_PREFIX,
  STANDALONE_MEDIA_TABLE_ELEMENT_ID,
  STANDALONE_ROOT_ELEMENT_ID,
  type StandaloneMediaTable,
  STANDALONE_FALLBACK_CLASS,
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
export const STANDALONE_HTML_CSP = standaloneHtmlCsp('data: blob:');

/**
 * Content Security Policy of a page that ships its files next to it (the ZIP
 * variant: `classroom.html` plus `images/`, `audio/` and `media/` folders).
 * Only `img-src` and `media-src` differ from the single file's: `'self'` lets
 * `<img>` (and CSS/SVG images, video posters) and `<audio>`/`<video>` load
 * the sibling files by relative path. Opened from disk, Chromium and WebKit
 * match `'self'` against `file:` URLs (without it they block the files);
 * served over HTTP, it is the page's own origin.
 *
 * What `'self'` opens up: served over HTTP, an image or media element (also
 * one in an interactive scene's frame, which inherits this policy) may make
 * a GET, with cookies, to any path on the page's own host. That is the reach
 * of a same-host link and reads nothing back: `connect-src 'none'` still
 * blocks fetch/XHR/WebSocket, so neither the player nor authored content can
 * read a response's bytes, and no request leaves the host. The player itself
 * never reads media bytes: it only hands relative paths to the browser.
 */
export const STANDALONE_HTML_LINKED_FILES_CSP = standaloneHtmlCsp("'self' data: blob:");

function standaloneHtmlCsp(linkedSources: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
    "style-src 'unsafe-inline' data:",
    `img-src ${linkedSources}`,
    `media-src ${linkedSources}`,
    'font-src data:',
    'frame-src data: blob:',
    'worker-src data: blob:',
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

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

const FALLBACK_STYLE = [
  // The root keeps the viewport's height (player CSS) even while empty; hide
  // it until the player mounts so the fallback message is on the first screen.
  `#${STANDALONE_ROOT_ELEMENT_ID}:empty{display:none}`,
  '.openmaic-message{box-sizing:border-box;max-width:32rem;margin:2rem auto;padding:1rem 1.25rem;',
  'font:16px/1.5 system-ui,-apple-system,sans-serif;color:#334155;text-align:center}',
  // Backstop for a slow parse: even when the message is reached before the
  // player script has run, it only becomes visible after a delay.
  `.${STANDALONE_FALLBACK_CLASS}{opacity:0;animation:openmaic-fallback-in 0s 2s forwards}`,
  `.${STANDALONE_FALLBACK_CLASS}[data-failed]{opacity:1;animation:none}`,
  '@keyframes openmaic-fallback-in{to{opacity:1}}',
].join('');

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
  /**
   * Playback media embedded as base64 data blocks, keyed as the manifest
   * names them (speech `audioRef`, video `mediaRef`).
   */
  embeddedMedia?: readonly StandaloneEmbeddedMedia[];
  /**
   * Playback media shipped next to the document and referenced by relative
   * path (requires `linkedFiles`).
   */
  linkedMedia?: readonly StandaloneLinkedMedia[];
  /**
   * The document ships files next to it (images, media) that the manifest
   * names by relative path; its CSP then lets image and media elements load
   * them (see {@link STANDALONE_HTML_LINKED_FILES_CSP}).
   */
  linkedFiles?: boolean;
  /** BCP 47 language tag of the player UI. */
  lang: string;
}

export interface StandaloneEmbeddedMedia {
  key: string;
  mimeType: string;
  /** The bytes as base64, whole or as pieces that concatenate into it. */
  base64: string | readonly string[];
}

export interface StandaloneLinkedMedia {
  key: string;
  mimeType: string;
  /** Relative URL of the file, resolved against the document (e.g. `media/clip.mp4`). */
  src: string;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The media table and its data blocks. Base64 cannot end a `<script>` element,
 * but the payload is checked anyway since it is written verbatim.
 */
function mediaBlocks(
  media: readonly StandaloneEmbeddedMedia[],
  linked: readonly StandaloneLinkedMedia[],
): string[] {
  if (media.length === 0 && linked.length === 0) return [];
  const table: StandaloneMediaTable = {};
  const blocks: string[] = [];
  media.forEach((entry, index) => {
    const pieces = typeof entry.base64 === 'string' ? [entry.base64] : entry.base64;
    if (!pieces.every((piece) => BASE64_PATTERN.test(piece))) {
      throw new Error(`Standalone HTML: media ${entry.key} is not base64`);
    }
    const id = `${STANDALONE_MEDIA_BLOCK_ID_PREFIX}${index + 1}`;
    table[entry.key] = { mimeType: entry.mimeType, embedded: id };
    blocks.push(`<script type="application/octet-stream" id="${id}">`, ...pieces, '</script>\n');
  });
  for (const entry of linked) {
    table[entry.key] = { mimeType: entry.mimeType, src: entry.src };
  }
  return [
    `<script type="application/json" id="${STANDALONE_MEDIA_TABLE_ELEMENT_ID}">${serializeJsonForHtmlScript(table)}</script>\n`,
    ...blocks,
  ];
}

/** Assemble the complete standalone document as one string (small documents, tests). */
export function assembleStandaloneHtml(input: StandaloneHtmlInput): string {
  return assembleStandaloneHtmlParts(input).join('');
}

/**
 * Assemble the complete standalone document as pieces to concatenate (e.g.
 * into a Blob), so embedded media never has to become one giant string:
 * V8 caps a string at about 2^29 characters.
 */
export function assembleStandaloneHtmlParts(input: StandaloneHtmlInput): string[] {
  const title = input.manifest.stage.name || 'Classroom';
  const styles = [input.playerStyle, ...(input.extraStyles ?? [])]
    .map(
      (css, index) => `<style>${assertRawText(css, 'style', `style sheet ${index + 1}`)}</style>`,
    )
    .join('\n');
  const line = (text: string) => `${text}\n`;
  const linkedMedia = input.linkedMedia ?? [];
  if (linkedMedia.length > 0 && !input.linkedFiles) {
    throw new Error('Standalone HTML: linked media needs a document with linked files');
  }
  const csp = input.linkedFiles ? STANDALONE_HTML_LINKED_FILES_CSP : STANDALONE_HTML_CSP;
  // Shown where the JavaScript player cannot run (iOS Files preview, scripts
  // disabled or blocked). It sits right before the player script, after the
  // data blocks, so nothing paints it while a large file is still being parsed;
  // the player removes it on mount. The <noscript> copy covers disabled
  // scripts and hides the script-dependent one.
  const strings = input.config.strings;
  const fallbackText = strings.scriptRequired ? escapeHtmlText(strings.scriptRequired) : '';
  const fallbackRoot = fallbackText
    ? `<p class="openmaic-message ${STANDALONE_FALLBACK_CLASS}" data-testid="script-fallback" data-failed-text="${escapeHtmlText(strings.startFailed ?? '')}">${fallbackText}</p>`
    : '';
  return [
    '<!doctype html>',
    `<html lang="${escapeHtmlText(input.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="OpenMAIC">',
    `<title>${escapeHtmlText(title)}</title>`,
    styles,
    `<style>${FALLBACK_STYLE}</style>`,
    ...(fallbackText
      ? [`<noscript><style>.${STANDALONE_FALLBACK_CLASS}{display:none}</style></noscript>`]
      : []),
    '</head>',
    '<body>',
    `<div id="${STANDALONE_ROOT_ELEMENT_ID}"></div>`,
    `<script type="application/json" id="${STANDALONE_MANIFEST_ELEMENT_ID}">${serializeJsonForHtmlScript(input.manifest)}</script>`,
    `<script type="application/json" id="${STANDALONE_CONFIG_ELEMENT_ID}">${serializeJsonForHtmlScript(input.config)}</script>`,
  ]
    .map(line)
    .concat(
      mediaBlocks(input.embeddedMedia ?? [], linkedMedia),
      [
        ...(fallbackText
          ? [fallbackRoot, `<noscript><p class="openmaic-message">${fallbackText}</p></noscript>`]
          : []),
        ...(input.extraScripts ?? []).map(
          (js, index) => `<script>${assertRawText(js, 'script', `script ${index + 1}`)}</script>`,
        ),
        `<script>${assertRawText(input.playerScript, 'script', 'player script')}</script>`,
        '</body>',
        '</html>',
      ].map(line),
    );
}
