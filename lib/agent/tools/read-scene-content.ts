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
 * @maic/dsl `PPTElement` union — each variant stashes its text differently:
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

function projectContent(content: SceneContext['content']): string {
  const c = content as { type?: string; canvas?: { elements?: unknown[] } } | undefined;
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
              text: `Error: scene context not found for sceneId "${sceneId}". Cannot read the scene.`,
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

      const { outline, content } = ctx;
      const keyPoints = (outline.keyPoints ?? []).join('; ');
      const projection = projectContent(content);
      return {
        content: [
          {
            type: 'text',
            text:
              `Scene "${outline.title}" (type: ${outline.type}). ` +
              `Description: ${outline.description || '(none)'}. ` +
              `Key points: ${keyPoints || '(none)'}.\n` +
              `Slide content:\n${projection}`,
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
