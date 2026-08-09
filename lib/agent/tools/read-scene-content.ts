/**
 * `read_scene_content` agent tool
 *
 * Read-only. Surfaces the current scene's outline + content to the model so it
 * can reason about the slide, answer questions about it, and distil a precise
 * instruction for `regenerate_scene`. This is the "read" half of read-then-act:
 * the model SEES the slide here (instead of regenerating blind), while the
 * trusted content used for execution still flows from the injected context.
 *
 * The content is pulled from the same client-injected `SceneContext`
 * (`getSceneContext`) the other tools use — no new data plumbing, and strictly
 * more token-efficient than pre-stuffing every scene into the system prompt.
 */

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { PPTElement } from '@openmaic/dsl';
import type { SceneContext } from './regenerate-scene-actions';
import { ALLOWED_EDIT_PROPS } from './edit-elements-gate';
import { EXACT_CONTENT_RAW_CAP, isExactContentEditable } from './edit-elements-content-contract';

// ── Deps ─────────────────────────────────────────────────────────────────────

export interface ReadSceneContentDeps {
  /** Returns the trusted scene/stage context for a scene id (client-sourced). */
  getSceneContext: (sceneId: string) => SceneContext | undefined;
  /** The active scene id, used when the model omits sceneId. */
  activeSceneId?: string;
  /** Active canvas selection ids, used to resolve "this" and "these". */
  getSelection?: () => readonly string[];
}

// ── Content projection (model-visible text) ──────────────────────────────────
// The model only sees `content[].text`, NOT `details`. Serialize a compact,
// human-readable projection of the actual content so it can reason about what
// is on the slide.

const PROJECTION_CAP = 2000;
const ELEMENT_TEXT_CAP = 80;
const SLIDE_PATCH_PROJECTION_CAP = 30000;
const MANIFEST_PAGE_CAP = 10000;

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Pull the human-readable text out of a single slide element. Mirrors the
 * @openmaic/dsl `PPTElement` union — each variant stashes its text differently:
 *   - text:  `content` (HTML string)
 *   - shape: `text.content` (ShapeText, HTML string)
 *   - table: `data` (TableCell[][], each cell carries `text`)
 *   - code:  `lines` (CodeLine[], each carries `content`)
 *   - latex: `latex` (source string)
 * Returns '' for elements with no meaningful text (image / line / chart / …).
 */
function extractElementText(el: unknown): string {
  const e = el as {
    type?: string;
    content?: unknown;
    text?: { content?: unknown };
    data?: unknown;
    lines?: unknown;
    latex?: unknown;
  };
  switch (e.type) {
    case 'text':
      return typeof e.content === 'string' ? stripHtml(e.content) : '';
    case 'shape':
      return typeof e.text?.content === 'string' ? stripHtml(e.text.content) : '';
    case 'table': {
      const rows = Array.isArray(e.data) ? (e.data as unknown[]) : [];
      return rows
        .flatMap((row) => (Array.isArray(row) ? (row as unknown[]) : []))
        .map((cell) => {
          const c = cell as { text?: unknown };
          return typeof c.text === 'string' ? stripHtml(c.text) : '';
        })
        .filter(Boolean)
        .join(' | ');
    }
    case 'code': {
      const lines = Array.isArray(e.lines) ? (e.lines as unknown[]) : [];
      return lines
        .map((line) => {
          const l = line as { content?: unknown };
          return typeof l.content === 'string' ? l.content : '';
        })
        .join(' ')
        .trim();
    }
    case 'latex':
      return typeof e.latex === 'string' ? e.latex.trim() : '';
    default:
      return '';
  }
}

// Interactive pages are edited with `edit_interactive_html`, which needs the
// model to author EXACT `oldText` anchors — so it must see the full, raw,
// un-escaped HTML (not a truncated JSON projection). Cap only as a pathological
// safety net; real pages (after eliding base64) are well under this.
const INTERACTIVE_HTML_CAP = 120000;

// Generated pages often inline vendor libs / media as huge base64 data-URIs
// (a single page can be ~760KB, ~95% base64). That payload is noise the model
// can't usefully edit and it pushes the actual code past any cap, so the model
// never sees the real JS/markup it needs to fix. Elide the base64 body to a tiny
// marker for the MODEL'S VIEW only — the edit tool still applies against the full
// stored HTML, and the model authors oldText from the real (non-base64) code.
function elideDataUris(html: string): string {
  return html.replace(
    /(data:[^;,]*;base64,)([A-Za-z0-9+/=]+)/g,
    (_m, prefix: string, payload: string) => `${prefix}…[${payload.length} base64 chars elided]`,
  );
}

function projectElementManifest(element: PPTElement, index: number): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    _index: index,
    _path: `/elements/${index}`,
    id: element.id,
    type: element.type,
  };
  if (element.name !== undefined) manifest.name = element.name;
  if (element.type === 'text' && element.textType !== undefined) {
    manifest.textType = element.textType;
  } else if (element.type === 'image' && element.imageType !== undefined) {
    manifest.imageType = element.imageType;
  } else if (element.type === 'chart') {
    manifest.chartType = element.chartType;
  }
  if (element.lock !== undefined) manifest.lock = element.lock;
  if (element.groupId !== undefined) manifest.groupId = element.groupId;
  const summary = truncate(extractElementText(element), ELEMENT_TEXT_CAP);
  if (summary) manifest._textSummary = summary;
  return manifest;
}

function projectElementForPatch(element: PPTElement, index: number): Record<string, unknown> {
  const source = element as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {
    _index: index,
    _path: `/elements/${index}`,
    id: element.id,
    type: element.type,
  };
  if (element.name !== undefined) projected.name = element.name;
  for (const key of ['lock', 'groupId', 'left', 'top', 'width', 'height', 'rotate']) {
    if (source[key] !== undefined) projected[key] = source[key];
  }
  for (const key of ALLOWED_EDIT_PROPS) {
    if (source[key] !== undefined) projected[key] = source[key];
  }
  if (element.type === 'text') {
    if (isExactContentEditable(element.content)) {
      projected.content = element.content;
    } else {
      projected._contentEdit = `content editing unavailable: HTML exceeds the exact ${EXACT_CONTENT_RAW_CAP}-character/serialized-record limit`;
    }
  } else if (element.type === 'shape' && element.text) {
    projected.text = {
      ...(isExactContentEditable(element.text.content)
        ? { content: element.text.content }
        : {
            _contentEdit: `content editing unavailable: HTML exceeds the exact ${EXACT_CONTENT_RAW_CAP}-character/serialized-record limit`,
          }),
      defaultFontName: element.text.defaultFontName,
      defaultColor: element.text.defaultColor,
      lineHeight: element.text.lineHeight,
      wordSpace: element.text.wordSpace,
      paragraphSpace: element.text.paragraphSpace,
      align: element.text.align,
    };
  } else {
    const summary = truncate(extractElementText(element), ELEMENT_TEXT_CAP);
    if (summary) projected._textSummary = summary;
  }
  return projected;
}

function projectContent(
  content: SceneContext['content'],
  selectionIds: readonly string[] = [],
  requestedElementIds: readonly string[] = [],
  manifestOffset = 0,
): string {
  const c = content as
    | { type?: string; canvas?: { elements?: unknown[] }; html?: unknown }
    | undefined;

  // Interactive: return the full page HTML verbatim so edits can anchor exactly.
  if (c?.type === 'interactive') {
    const raw = typeof c.html === 'string' ? c.html : '';
    if (!raw) return '(this interactive scene has no embedded HTML)';
    // Elide base64 payloads first so the real code is visible within the cap.
    const html = elideDataUris(raw);
    const capped =
      html.length > INTERACTIVE_HTML_CAP
        ? `${html.slice(0, INTERACTIVE_HTML_CAP)}…(truncated)`
        : html;
    return `Interactive page HTML (to fix a bug, call edit_interactive_html with exact oldText snippets copied verbatim from below; base64 payloads are shown elided — never use them as oldText):\n${capped}`;
  }

  let projection: string;
  if (c?.type === 'slide') {
    const elements = Array.isArray(c.canvas?.elements) ? (c.canvas!.elements as PPTElement[]) : [];
    const indexById = new Map<string, number>();
    const duplicateIds = new Set<string>();
    elements.forEach((element, index) => {
      if (indexById.has(element.id)) duplicateIds.add(element.id);
      else indexById.set(element.id, index);
    });
    const selected = selectionIds.filter((id) => indexById.has(id));
    const requested = [...new Set(requestedElementIds)].filter((id) => indexById.has(id));
    const allManifestEntries = elements.map((element, index) =>
      projectElementManifest(element, index),
    );
    const manifestEntries: Record<string, unknown>[] = [];
    let nextManifestOffset: number | null = null;
    if (requested.length > 0) {
      for (const id of requested) manifestEntries.push(allManifestEntries[indexById.get(id)!]);
    } else {
      let manifestSize = 2;
      for (let index = Math.max(0, manifestOffset); index < allManifestEntries.length; index++) {
        const entry = allManifestEntries[index];
        const serialized = JSON.stringify(entry);
        if (manifestEntries.length > 0 && manifestSize + serialized.length > MANIFEST_PAGE_CAP) {
          nextManifestOffset = index;
          break;
        }
        manifestEntries.push(entry);
        manifestSize += serialized.length + 1;
      }
    }
    const manifest = JSON.stringify(manifestEntries, null, 2);
    const allDetails = elements.map((element, index) => projectElementForPatch(element, index));
    const allDetailsJson = JSON.stringify(allDetails, null, 2);
    const detailIds = requested.length > 0 ? requested : selected;
    const candidateDetails =
      allDetailsJson.length <= SLIDE_PATCH_PROJECTION_CAP && requested.length === 0
        ? allDetails
        : detailIds.length > 0
          ? detailIds.map((id) => {
              const index = indexById.get(id)!;
              return projectElementForPatch(elements[index], index);
            })
          : [];
    const details: Record<string, unknown>[] = [];
    const omittedDetailIds: string[] = [];
    let detailSize = 2;
    const detailBudget =
      requested.length === 1 ? Number.POSITIVE_INFINITY : SLIDE_PATCH_PROJECTION_CAP;
    for (const detail of candidateDetails) {
      const serialized = JSON.stringify(detail, null, 2);
      if (detailSize + serialized.length <= detailBudget) {
        details.push(detail);
        detailSize += serialized.length + 2;
      } else if (typeof detail.id === 'string') {
        omittedDetailIds.push(detail.id);
      }
    }
    const detailsText =
      details.length > 0
        ? JSON.stringify(details, null, 2)
        : '(omitted because the exact records are large; call read_scene_content again with elementIds for the elements you intend to patch)';
    projection =
      'Slide element manifest page. Identity fields (`id`, `type`, `name`) and underscore-prefixed projection metadata are read-only; patch editable real paths under `/elements` and guard every index with an id test.\n' +
      manifest +
      (nextManifestOffset !== null
        ? `\nManifest continues. Next manifestOffset: ${nextManifestOffset}.`
        : '') +
      '\nExact editable element records:\n' +
      detailsText +
      (omittedDetailIds.length > 0
        ? `\nExact records omitted to stay within the read budget: ${omittedDetailIds.join(', ')}. Request fewer elementIds.`
        : '') +
      (duplicateIds.size > 0
        ? `\nWarning: duplicate element ids make JSON Patch editing unavailable: ${[...duplicateIds].join(', ')}.`
        : '') +
      `\nSelected element ids on this slide: ${selected.length > 0 ? selected.join(', ') : '(none)'}`;
    return projection;
  } else {
    projection = JSON.stringify(content ?? {});
  }
  return projection.length > PROJECTION_CAP
    ? `${projection.slice(0, PROJECTION_CAP)}…(truncated)`
    : projection;
}

// ── Params ───────────────────────────────────────────────────────────────────
// The model only needs to say WHICH scene to read; defaults to the active one.

export const ReadSceneContentParams = Type.Object({
  sceneId: Type.Optional(
    Type.String({
      description:
        'The id of the scene to read. Defaults to the current scene shown in the system prompt.',
    }),
  ),
  elementIds: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 50,
      uniqueItems: true,
      description:
        'Existing slide element ids whose exact editable records should be returned. Use this after reading a large slide manifest.',
    }),
  ),
  manifestOffset: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: 'Offset returned by a previous manifest page for very large slides.',
    }),
  ),
});

export type ReadSceneContentParams = Static<typeof ReadSceneContentParams>;

// ── Details returned to the client ───────────────────────────────────────────

// Compact metadata only. The model gets the full content via `content[].text`;
// the client apply path never reads this tool's `details.content`, so echoing
// the raw scene content here is dead weight (and megabytes for base64 images).
export interface ReadSceneContentDetails {
  sceneId: string;
  title: string;
  type: string;
  /** Short text-only outline (title / description / keyPoints) — safe to keep. */
  outline: SceneContext['outline'];
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function makeReadSceneContentTool(
  deps: ReadSceneContentDeps,
): AgentTool<typeof ReadSceneContentParams, ReadSceneContentDetails> {
  return {
    name: 'read_scene_content',
    label: 'Read scene content',
    description:
      'Reads the current scene to understand what is on it — its outline (title, ' +
      'description, key points) and its content (slide elements / quiz questions / etc). ' +
      'Use this BEFORE answering questions about the slide or regenerating it, so your ' +
      'reply and any regeneration instruction reflect what is actually on the slide. ' +
      'For large slides, follow manifestOffset pages, then pass elementIds from the manifest ' +
      'to retrieve exact target records.',
    parameters: ReadSceneContentParams,

    execute: async (_toolCallId, params) => {
      const sceneId = params.sceneId || deps.activeSceneId || '';
      const ctx = deps.getSceneContext(sceneId);
      if (!ctx) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: scene context not found for sceneId ${JSON.stringify(String(sceneId).slice(0, 200))}. Cannot read the scene.`,
            },
          ],
          details: {
            sceneId,
            title: '',
            type: '',
            outline: undefined as unknown as SceneContext['outline'],
          },
          isError: true,
        };
      }

      const { outline, content, runtimeErrors } = ctx;
      const keyPoints = (outline.keyPoints ?? []).join('; ');
      const projection = projectContent(
        content,
        deps.getSelection?.() ?? [],
        params.elementIds ?? [],
        params.manifestOffset ?? 0,
      );
      // Surface any runtime errors the page threw when it rendered — for an
      // interactive scene these are usually the real reason it's blank/broken, so
      // the agent fixes the root cause instead of guessing from the static HTML.
      const errorsSection =
        runtimeErrors && runtimeErrors.length > 0
          ? `\n\nRuntime errors this page reported when it rendered (these are the likely reason it is blank/broken — fix the ROOT CAUSE shown here, do not guess):\n` +
            runtimeErrors.map((e) => `- ${e}`).join('\n')
          : '';
      return {
        content: [
          {
            type: 'text',
            text:
              `Scene "${outline.title}" (type: ${outline.type}). ` +
              `Description: ${outline.description || '(none)'}. ` +
              `Key points: ${keyPoints || '(none)'}.\n` +
              `Scene content:\n${projection}${errorsSection}`,
          },
        ],
        details: {
          sceneId,
          title: outline.title,
          type: outline.type,
          outline,
        },
      };
    },
  };
}
