import type { Action, PPTElement } from '@openmaic/dsl';
import type { AssetMeta, AssetSource, CompilerScene, TimingProbe } from '@/lib/video-export';

/** Build an action-like object with a stable id (accepts invalid types for validation tests). */
export const act = (a: { id: string; type: string; [k: string]: unknown }): Action =>
  a as unknown as Action;

export const speech = (id: string, text: string, extra: Record<string, unknown> = {}): Action =>
  act({ id, type: 'speech', text, ...extra });

export const spotlight = (id: string, elementId: string, dimOpacity?: number): Action =>
  act({ id, type: 'spotlight', elementId, ...(dimOpacity != null ? { dimOpacity } : {}) });

export const laser = (id: string, elementId: string, color?: string): Action =>
  act({ id, type: 'laser', elementId, ...(color != null ? { color } : {}) });

export const playVideo = (id: string, elementId: string): Action =>
  act({ id, type: 'play_video', elementId });

export const wbDrawText = (id: string, content: string): Action =>
  act({ id, type: 'wb_draw_text', content });

/** A positioned slide element (only geometry fields matter here). */
export const el = (
  id: string,
  box: { left: number; top: number; width: number; height: number; rotate?: number },
): PPTElement => ({ id, type: 'text', ...box }) as unknown as PPTElement;

export function slide(
  id: string,
  actions: Action[],
  opts: { elements?: PPTElement[]; order?: number; title?: string } = {},
): CompilerScene {
  return {
    id,
    stageId: 'stage',
    title: opts.title ?? id,
    order: opts.order ?? 0,
    type: 'slide',
    content: { type: 'slide', canvas: { elements: opts.elements ?? [] } },
    actions,
  } as CompilerScene;
}

export function quiz(id: string, actions: Action[] = [], order = 0): CompilerScene {
  return {
    id,
    stageId: 'stage',
    title: id,
    order,
    type: 'quiz',
    content: { type: 'quiz' },
    actions,
  } as CompilerScene;
}

/** TimingProbe stub: audio/video durations keyed by action id; anything else → estimate/null. */
export function stubProbe(
  audioMs: Record<string, number> = {},
  videoMs: Record<string, number> = {},
): TimingProbe {
  return {
    audioDurationMs: (a) => (a.id && a.id in audioMs ? audioMs[a.id] : null),
    videoDurationMs: (a) => (a.id && a.id in videoMs ? videoMs[a.id] : null),
  };
}

/** AssetSource stub: audio keyed by action id, media keyed by elementId. */
export function stubAssets(
  audio: Record<string, AssetMeta> = {},
  media: Record<string, AssetMeta> = {},
): AssetSource {
  return {
    audio: (a) => (a.id && a.id in audio ? audio[a.id] : null),
    media: (elementId) => (elementId in media ? media[elementId] : null),
  };
}

export const NO_PROBE: TimingProbe = { audioDurationMs: () => null, videoDurationMs: () => null };
export const NO_ASSETS: AssetSource = { audio: () => null, media: () => null };
