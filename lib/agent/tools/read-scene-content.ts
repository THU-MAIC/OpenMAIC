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
import type { SceneContext } from './regenerate-scene-actions';

// ── Deps ─────────────────────────────────────────────────────────────────────

export interface ReadSceneContentDeps {
  /** Returns the trusted scene/stage context for a scene id (client-sourced). */
  getSceneContext: (sceneId: string) => SceneContext | undefined;
  /** The active scene id, used when the model omits sceneId. */
  activeSceneId?: string;
}

// ── Content projection (model-visible text) ──────────────────────────────────
// The model only sees `content[].text`, NOT `details`. Serialize a compact,
// human-readable projection of the actual content so it can reason about what
// is on the slide.

const PROJECTION_CAP = 2000;
const ELEMENT_TEXT_CAP = 80;

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

function projectContent(content: SceneContext['content']): string {
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
    const elements = Array.isArray(c.canvas?.elements) ? c.canvas!.elements : [];
    projection = elements
      .map((el) => {
        const e = el as { type?: string };
        const type = e.type ?? 'element';
        const text = truncate(extractElementText(el), ELEMENT_TEXT_CAP);
        return text ? `- ${type}: ${text}` : `- ${type}`;
      })
      .join('\n');
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
      'Only supply the sceneId — the scene data is loaded automatically.',
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
      const projection = projectContent(content);
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
