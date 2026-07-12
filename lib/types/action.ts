// Unified Action System.
//
// The Action contract — the playback verb set agents use to drive a
// presentation — now lives in `@openmaic/dsl` and is re-exported below, so the
// runtime engine, renderer, importer, and this app all share one source of
// truth. Both the online (streaming) and offline (playback) paths consume the
// same Action types.
//
// This module is a thin re-export shim (same pattern as `@/lib/types/stage`):
// existing `import { … } from '@/lib/types/action'` callers keep working
// unchanged.

export type {
  ActionBase,
  SpotlightAction,
  LaserAction,
  SpeechAction,
  WbOpenAction,
  WbDrawTextAction,
  WbDrawShapeAction,
  WbDrawChartAction,
  WbDrawLatexAction,
  WbDrawTableAction,
  WbDrawLineAction,
  WbClearAction,
  WbDeleteAction,
  WbCloseAction,
  WbDrawCodeAction,
  WbEditCodeAction,
  PlayVideoAction,
  DiscussionAction,
  WidgetHighlightAction,
  WidgetSetStateAction,
  WidgetAnnotationAction,
  WidgetRevealAction,
  Action,
  ActionType,
  PercentageGeometry,
} from '@openmaic/dsl';

// The action-category lists are runtime values (plain arrays), so they must be
// value re-exported — a bare `export type {}` would erase them and leave the
// imports as `undefined` at runtime.
export { FIRE_AND_FORGET_ACTIONS, SLIDE_ONLY_ACTIONS, SYNC_ACTIONS } from '@openmaic/dsl';
