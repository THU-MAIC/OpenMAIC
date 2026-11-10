/**
 * Single source of truth for the timeline's cue/element taxonomy: per action
 * type, the icon + i18n label key + glyph tint; the set of
 * element-bound cue types; and element-type label keys. Previously these maps
 * were duplicated across ActionsBar, regenerate-tool-ui and ElementPickLayer.
 *
 * Labels are i18n KEYS (resolved by the caller via `t()`), not literals, so the
 * pure module stays hook-free while the UI text goes through `useTranslation`.
 */
import {
  ChartColumn,
  Circle,
  CodeXml,
  Crosshair,
  Eraser,
  Eye,
  FilePen,
  Flag,
  Focus,
  Highlighter,
  Minus,
  PenLine,
  Play,
  Presentation,
  Quote,
  Shapes,
  Sigma,
  SlidersHorizontal,
  SquareX,
  StickyNote,
  Table2,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { Action, ActionType } from '@openmaic/dsl';
import { elementRefLabel } from '@/lib/workbench/element-refs';

/** Translator fn (matches useI18n's `t`) — passed in so this module stays hook-free. */
type TFn = (key: string, options?: Record<string, unknown>) => string;

export interface CueMeta {
  icon: LucideIcon;
  /** i18n key under `edit.cue.*`; resolve with `t(labelKey)`. */
  labelKey: string;
  /** glyph tint: icon color + soft disc background */
  glyph: string;
  /** dashed-border tint used by a "needs target" cue card */
  dash: string;
}

const WHITEBOARD_TINT = {
  glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400',
  dash: 'border-primary/40',
} as const;

/**
 * Every action type has its entry: keyed by the union, so a new type is a type
 * error here until it is designed (`tests/edit/cue-meta.test.ts` holds the same
 * line at runtime, with its label in every locale).
 */
const META: Record<ActionType, CueMeta> = {
  speech: {
    icon: Quote,
    labelKey: 'edit.cue.speech',
    glyph: 'text-primary bg-primary/10 dark:text-primary',
    dash: 'border-primary/40',
  },
  spotlight: {
    icon: Focus,
    labelKey: 'edit.cue.spotlight',
    glyph: 'text-amber-600 bg-amber-500/10 dark:text-amber-400',
    dash: 'border-amber-400/70',
  },
  laser: {
    icon: Crosshair,
    labelKey: 'edit.cue.laser',
    glyph: 'text-rose-600 bg-rose-500/10 dark:text-rose-400',
    dash: 'border-rose-400/70',
  },
  wb_open: {
    icon: Presentation,
    labelKey: 'edit.cue.whiteboardOpen',
    glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400',
    dash: 'border-primary/40',
  },
  wb_draw_text: {
    icon: PenLine,
    labelKey: 'edit.cue.whiteboardText',
    glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400',
    dash: 'border-primary/40',
  },
  wb_draw_shape: {
    icon: Shapes,
    labelKey: 'edit.cue.whiteboardShape',
    glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400',
    dash: 'border-primary/40',
  },
  wb_draw_latex: {
    icon: Sigma,
    labelKey: 'edit.cue.whiteboardLatex',
    glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400',
    dash: 'border-primary/40',
  },
  wb_draw_table: {
    icon: Table2,
    labelKey: 'edit.cue.whiteboardTable',
    glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400',
    dash: 'border-primary/40',
  },
  wb_draw_chart: { icon: ChartColumn, labelKey: 'edit.cue.whiteboardChart', ...WHITEBOARD_TINT },
  wb_draw_line: { icon: Minus, labelKey: 'edit.cue.whiteboardLine', ...WHITEBOARD_TINT },
  wb_draw_code: { icon: CodeXml, labelKey: 'edit.cue.whiteboardCode', ...WHITEBOARD_TINT },
  wb_edit_code: { icon: FilePen, labelKey: 'edit.cue.whiteboardEditCode', ...WHITEBOARD_TINT },
  wb_delete: { icon: Trash2, labelKey: 'edit.cue.whiteboardDelete', ...WHITEBOARD_TINT },
  wb_clear: { icon: Eraser, labelKey: 'edit.cue.whiteboardClear', ...WHITEBOARD_TINT },
  wb_close: { icon: SquareX, labelKey: 'edit.cue.whiteboardClose', ...WHITEBOARD_TINT },
  play_video: {
    icon: Play,
    labelKey: 'edit.cue.playVideo',
    glyph: 'text-yellow-600 bg-yellow-500/10 dark:text-yellow-400',
    dash: 'border-yellow-400/70',
  },
  widget_highlight: {
    icon: Highlighter,
    labelKey: 'edit.cue.widgetHighlight',
    glyph: 'text-amber-600 bg-amber-500/10 dark:text-amber-400',
    dash: 'border-amber-400/70',
  },
  widget_setState: {
    icon: SlidersHorizontal,
    labelKey: 'edit.cue.widgetSetState',
    glyph: 'text-indigo-600 bg-indigo-500/10 dark:text-indigo-400',
    dash: 'border-indigo-400/70',
  },
  widget_annotation: {
    icon: StickyNote,
    labelKey: 'edit.cue.widgetAnnotation',
    glyph: 'text-sky-600 bg-sky-500/10 dark:text-sky-400',
    dash: 'border-sky-400/70',
  },
  widget_reveal: {
    icon: Eye,
    labelKey: 'edit.cue.widgetReveal',
    glyph: 'text-emerald-600 bg-emerald-500/10 dark:text-emerald-400',
    dash: 'border-emerald-400/70',
  },
  discussion: {
    icon: Flag,
    labelKey: 'edit.cue.discussion',
    glyph: 'text-yellow-600 bg-yellow-500/10 dark:text-yellow-400',
    dash: 'border-primary/40',
  },
};

const FALLBACK: CueMeta = {
  icon: Circle,
  labelKey: 'edit.cue.action',
  glyph: 'text-muted-foreground bg-muted',
  dash: 'border-muted-foreground/30',
};

/** The types with a designed entry. */
export const DESIGNED_CUE_TYPES = Object.keys(META) as readonly ActionType[];

function metaOf(type: string): CueMeta | undefined {
  return Object.hasOwn(META, type) ? META[type as ActionType] : undefined;
}

/** A type from older data, or a newer build, gets the generic card rather than a crash. */
export function cueMeta(type: string): CueMeta {
  return metaOf(type) ?? FALLBACK;
}

/** Localized cue label; an unknown type reads as "Action". */
export function cueLabel(type: string, t: TFn): string {
  return t((metaOf(type) ?? FALLBACK).labelKey);
}

const CUE_SUMMARY_MAX = 80;

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > CUE_SUMMARY_MAX ? `${line.slice(0, CUE_SUMMARY_MAX - 1)}…` : line;
}

/** A selector as a name: `#result-list` reads as `result-list`. */
function targetName(target: unknown): string {
  return typeof target === 'string' ? target.replace(/^[#.]/, '') : '';
}

/** `age 5 · budget mid`: only what reads as a value, never raw JSON. */
function stateSummary(state: unknown): string {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return '';
  return Object.entries(state)
    .flatMap(([key, value]) => {
      if (typeof value === 'boolean') return [`${key} ${value ? '✓' : '✗'}`];
      if (typeof value === 'string' || typeof value === 'number') return [`${key} ${value}`];
      return [key];
    })
    .join(' · ');
}

/**
 * One line of what an action does, from its own parameters; empty when it has
 * none worth saying (closing the whiteboard). Spoken lines and discussions show
 * their text on their own cards, and an element-bound cue names its element.
 */
export function cueSummary(action: Action | { readonly type: string }): string {
  const a = action as Action;
  switch (a.type) {
    case 'widget_highlight':
    case 'widget_annotation':
    case 'widget_reveal':
      return clip(targetName(a.target));
    case 'widget_setState':
      return clip(stateSummary(a.state));
    case 'wb_draw_text':
      return clip(String(a.content ?? '').replace(/<[^>]*>/g, ' '));
    case 'wb_draw_latex':
      return clip(String(a.latex ?? ''));
    case 'wb_draw_shape':
      return clip(String(a.shape ?? ''));
    case 'wb_draw_chart':
      return clip((a.data?.labels ?? []).join(' · '));
    case 'wb_draw_table':
      return a.data?.length ? `${a.data.length} × ${a.data[0]?.length ?? 0}` : '';
    case 'wb_draw_code':
      return clip(a.fileName || a.language || '');
    case 'wb_edit_code':
    case 'wb_delete':
      return clip(String(a.elementId ?? ''));
    default:
      return '';
  }
}

/** Cue types that target a canvas element (so canvas pick mode applies). */
export { ELEMENT_BOUND_CUE_TYPES as ELEMENT_BOUND } from '@openmaic/dsl';

/** Human label for a slide element (localized type + a short content snippet). */
export function elementLabel(el: { type: string; content?: string }, t: TFn): string {
  return elementRefLabel(el, t);
}
