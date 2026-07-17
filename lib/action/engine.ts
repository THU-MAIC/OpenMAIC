/**
 * ActionEngine — Unified execution layer for all agent actions.
 *
 * Replaces the 28 Vercel AI SDK tools in ai-tools.ts with a single engine
 * that both online (streaming) and offline (playback) paths share.
 *
 * Two execution modes:
 * - Fire-and-forget: spotlight, laser — dispatch and return immediately
 * - Synchronous: speech, whiteboard, discussion — await completion
 */

import type { StageStore } from '@/lib/api/stage-api';
import { createStageAPI } from '@/lib/api/stage-api';
import { useCanvasStore } from '@/lib/store/canvas';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { useMediaGenerationStore, isMediaPlaceholder } from '@/lib/store/media-generation';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import type {
  Action,
  SpotlightAction,
  LaserAction,
  SpeechAction,
  PlayVideoAction,
  WbDrawTextAction,
  WbDrawShapeAction,
  WbDrawChartAction,
  WbDrawLatexAction,
  WbDrawTableAction,
  WbDeleteAction,
  WbDrawLineAction,
  WbDrawCodeAction,
  WbEditCodeAction,
  WidgetHighlightAction,
  WidgetSetStateAction,
  WidgetAnnotationAction,
  WidgetRevealAction,
} from '@/lib/types/action';
import type { CodeLine } from '@openmaic/dsl';
import {
  EFFECT_AUTO_CLEAR_MS,
  MAX_VIDEO_WAIT_MS,
  WB_OPEN_MS,
  WB_DRAW_MS,
  WB_EDIT_MS,
  WB_DELETE_MS,
  WB_CLOSE_MS,
  WIDGET_MS,
  wbDrawCodeMs,
  wbClearMs,
} from '@/lib/choreography';
import katex from 'katex';
import { createLogger } from '@/lib/logger';

const log = createLogger('ActionEngine');

// ==================== SVG Paths for Shapes ====================

const SHAPE_PATHS: Record<string, string> = {
  rectangle: 'M 0 0 L 1000 0 L 1000 1000 L 0 1000 Z',
  circle: 'M 500 0 A 500 500 0 1 1 499 0 Z',
  triangle: 'M 500 0 L 1000 1000 L 0 1000 Z',
};

// ==================== Helpers ====================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convert raw code string to CodeLine array with unique IDs */
function codeToLines(code: string): CodeLine[] {
  return code.split('\n').map((content, i) => ({
    id: `L${i + 1}`,
    content,
  }));
}

let lineIdCounter = 0;
/** Generate unique line IDs for newly inserted lines */
function generateLineIds(count: number): string[] {
  return Array.from({ length: count }, () => `L_${++lineIdCounter}_${Date.now().toString(36)}`);
}

// ==================== ActionEngine ====================

/** Callback for sending messages to widget iframe */
export type WidgetMessageCallback = (type: string, payload: Record<string, unknown>) => void;

export interface ActionExecutionOptions {
  silent?: boolean;
  signal?: AbortSignal;
}

export class ActionEngine {
  private stageStore: StageStore;
  private stageAPI: ReturnType<typeof createStageAPI>;
  private audioPlayer: AudioPlayer | null;
  private effectTimer: ReturnType<typeof setTimeout> | null = null;
  private widgetMessageCallback: WidgetMessageCallback | null = null;

  constructor(
    stageStore: StageStore,
    audioPlayer?: AudioPlayer | null,
    widgetMessageCallback?: WidgetMessageCallback | null,
  ) {
    this.stageStore = stageStore;
    this.stageAPI = createStageAPI(stageStore);
    this.audioPlayer = audioPlayer ?? null;
    this.widgetMessageCallback = widgetMessageCallback ?? null;
  }

  /** Set callback for sending messages to widget iframe */
  setWidgetMessageCallback(callback: WidgetMessageCallback | null): void {
    this.widgetMessageCallback = callback;
  }

  /** Clean up timers when the engine is no longer needed */
  dispose(): void {
    if (this.effectTimer) {
      clearTimeout(this.effectTimer);
      this.effectTimer = null;
    }
  }

  /**
   * Execute a single action.
   * Fire-and-forget actions return immediately.
   * Synchronous actions return a Promise that resolves when the action is complete.
   */
  async execute(action: Action, options: ActionExecutionOptions = {}): Promise<void> {
    if (options.silent) {
      if (action.type === 'speech' || action.type === 'spotlight' || action.type === 'laser') {
        return;
      }
      if (action.type === 'discussion' || action.type === 'play_video') {
        return;
      }
      if (action.type.startsWith('widget_')) {
        return;
      }
    }

    // Auto-open whiteboard if a draw/clear/delete action is attempted while it's closed
    if (action.type.startsWith('wb_') && action.type !== 'wb_open' && action.type !== 'wb_close') {
      await this.ensureWhiteboardOpen(options);
    }

    switch (action.type) {
      // Fire-and-forget
      case 'spotlight':
        this.executeSpotlight(action);
        return;
      case 'laser':
        this.executeLaser(action);
        return;
      // Synchronous — Video
      case 'play_video':
        return this.executePlayVideo(action as PlayVideoAction, options);

      // Synchronous
      case 'speech':
        return this.executeSpeech(action);
      case 'wb_open':
        return this.executeWbOpen(options);
      case 'wb_draw_text':
        return this.executeWbDrawText(action, options);
      case 'wb_draw_shape':
        return this.executeWbDrawShape(action, options);
      case 'wb_draw_chart':
        return this.executeWbDrawChart(action, options);
      case 'wb_draw_latex':
        return this.executeWbDrawLatex(action, options);
      case 'wb_draw_table':
        return this.executeWbDrawTable(action, options);
      case 'wb_draw_line':
        return this.executeWbDrawLine(action as WbDrawLineAction, options);
      case 'wb_draw_code':
        return this.executeWbDrawCode(action as WbDrawCodeAction, options);
      case 'wb_edit_code':
        return this.executeWbEditCode(action as WbEditCodeAction, options);
      case 'wb_clear':
        return this.executeWbClear(options);
      case 'wb_delete':
        return this.executeWbDelete(action as WbDeleteAction, options);
      case 'wb_close':
        return this.executeWbClose(options);
      case 'discussion':
        // Discussion lifecycle is managed externally via engine callbacks
        return;

      // Widget actions — post message to iframe
      case 'widget_highlight':
        return this.executeWidgetHighlight(action as WidgetHighlightAction);
      case 'widget_setState':
        return this.executeWidgetSetState(action as WidgetSetStateAction);
      case 'widget_annotation':
        return this.executeWidgetAnnotation(action as WidgetAnnotationAction);
      case 'widget_reveal':
        return this.executeWidgetReveal(action as WidgetRevealAction);
    }
  }

  /** Clear all active visual effects */
  clearEffects(): void {
    if (this.effectTimer) {
      clearTimeout(this.effectTimer);
      this.effectTimer = null;
    }
    useCanvasStore.getState().clearAllEffects();
  }

  resetPlaybackVisualState(): void {
    this.clearEffects();
    useCanvasStore.getState().pauseVideo();
    useCanvasStore.getState().setWhiteboardOpen(false);
    useCanvasStore.getState().setWhiteboardClearing(false);
    const wb = this.stageAPI.whiteboard.get();
    if (wb.success && wb.data) {
      this.stageAPI.whiteboard.update({ elements: [] }, wb.data.id);
    }
  }

  /** Schedule auto-clear for fire-and-forget effects */
  private scheduleEffectClear(): void {
    if (this.effectTimer) {
      clearTimeout(this.effectTimer);
    }
    this.effectTimer = setTimeout(() => {
      useCanvasStore.getState().clearAllEffects();
      this.effectTimer = null;
    }, EFFECT_AUTO_CLEAR_MS);
  }

  // ==================== Fire-and-forget ====================

  private executeSpotlight(action: SpotlightAction): void {
    useCanvasStore.getState().setSpotlight(action.elementId, {
      dimness: action.dimOpacity ?? 0.5,
    });
    this.scheduleEffectClear();
  }

  private executeLaser(action: LaserAction): void {
    useCanvasStore.getState().setLaser(action.elementId, {
      color: action.color ?? '#ff0000',
    });
    this.scheduleEffectClear();
  }

  // ==================== Synchronous — Speech ====================

  private async executeSpeech(action: SpeechAction): Promise<void> {
    if (!this.audioPlayer) return;

    return new Promise<void>((resolve) => {
      this.audioPlayer!.onEnded(() => resolve());
      this.audioPlayer!.play(action.audioId || '', action.audioUrl)
        .then((audioStarted) => {
          if (!audioStarted) resolve();
        })
        .catch(() => resolve());
    });
  }

  // ==================== Synchronous — Video ====================

  private async executePlayVideo(
    action: PlayVideoAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) return;
    // Resolve the video element to a generated media reference.
    // action.elementId is the slide element ID (e.g. video_abc123), but the media
    // store is keyed by generated media refs, so we need to bridge the two.
    const placeholderId = this.resolveMediaPlaceholderId(action.elementId);

    if (placeholderId) {
      const task = useMediaGenerationStore.getState().getTask(placeholderId);
      if (task && task.status !== 'done') {
        // Wait for media to be ready (or fail)
        await new Promise<void>((resolve) => {
          let unsubscribe = () => {};
          const finish = () => {
            unsubscribe();
            options.signal?.removeEventListener('abort', finish);
            resolve();
          };
          unsubscribe = useMediaGenerationStore.subscribe((state) => {
            const t = state.tasks[placeholderId];
            if (!t || t.status === 'done' || t.status === 'failed') {
              finish();
            }
          });
          options.signal?.addEventListener('abort', finish, { once: true });
          // Check again in case it resolved between getState and subscribe
          const current = useMediaGenerationStore.getState().tasks[placeholderId];
          if (!current || current.status === 'done' || current.status === 'failed') {
            finish();
          }
        });

        if (options.signal?.aborted) return;

        // If failed, skip playback
        if (useMediaGenerationStore.getState().tasks[placeholderId]?.status === 'failed') {
          return;
        }
      }
    }

    if (options.signal?.aborted) return;
    useCanvasStore.getState().playVideo(action.elementId);

    // Wait until the video finishes playing, with a safety timeout to prevent
    // the playback engine from hanging indefinitely if the video element is
    // invalid or the state change is missed.
    return new Promise<void>((resolve) => {
      let finished = false;
      let unsubscribe = () => {};
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        unsubscribe();
        options.signal?.removeEventListener('abort', abortPlayback);
        resolve();
      };
      const abortPlayback = () => {
        if (useCanvasStore.getState().playingVideoElementId === action.elementId) {
          useCanvasStore.getState().pauseVideo();
        }
        finish();
      };
      const timeout = setTimeout(() => {
        log.warn(`[playVideo] Timeout waiting for video ${action.elementId} to finish`);
        finish();
      }, MAX_VIDEO_WAIT_MS);
      unsubscribe = useCanvasStore.subscribe((state) => {
        if (state.playingVideoElementId !== action.elementId) {
          finish();
        }
      });
      options.signal?.addEventListener('abort', abortPlayback, { once: true });
      if (useCanvasStore.getState().playingVideoElementId !== action.elementId) {
        finish();
      }
    });
  }

  // ==================== Helpers — Media Resolution ====================

  /**
   * Look up a video/image element's generated media reference in the current stage's scenes.
   * Returns mediaRef first, then legacy src if it's a media placeholder ID.
   */
  private resolveMediaPlaceholderId(elementId: string): string | null {
    const { scenes, currentSceneId } = this.stageStore.getState();

    // Search current scene first for efficiency, then remaining scenes
    const orderedScenes = currentSceneId
      ? [
          scenes.find((s) => s.id === currentSceneId),
          ...scenes.filter((s) => s.id !== currentSceneId),
        ]
      : scenes;

    for (const scene of orderedScenes) {
      if (!scene || scene.type !== 'slide') continue;
      const elements = (
        scene.content as {
          canvas?: { elements?: Array<{ id: string; src?: string; mediaRef?: string }> };
        }
      )?.canvas?.elements;
      if (!Array.isArray(elements)) continue;
      const el = elements.find((e: { id: string }) => e.id === elementId);
      if (el && typeof el.mediaRef === 'string') {
        return el.mediaRef;
      }
      if (el && typeof el.src === 'string' && isMediaPlaceholder(el.src)) {
        return el.src;
      }
    }
    return null;
  }

  // ==================== Synchronous — Whiteboard ====================

  /** Auto-open the whiteboard if it's not already open */
  private async ensureWhiteboardOpen(options: ActionExecutionOptions = {}): Promise<void> {
    if (!useCanvasStore.getState().whiteboardOpen) {
      await this.executeWbOpen(options);
    }
  }

  private async executeWbOpen(options: ActionExecutionOptions = {}): Promise<void> {
    // Ensure a whiteboard exists
    this.stageAPI.whiteboard.get();
    useCanvasStore.getState().setWhiteboardOpen(true);
    if (options.silent) return;
    // Wait for open animation to complete (slow spring: stiffness 120, damping 18, mass 1.2)
    await delay(WB_OPEN_MS);
  }

  private async executeWbDrawText(
    action: WbDrawTextAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    const fontSize = action.fontSize ?? 18;
    let htmlContent = action.content ?? '';
    if (!htmlContent) return; // nothing to draw
    if (!htmlContent.startsWith('<')) {
      htmlContent = `<p style="font-size: ${fontSize}px;">${htmlContent}</p>`;
    }

    this.stageAPI.whiteboard.addElement(
      {
        id: action.elementId || '',
        type: 'text',
        content: htmlContent,
        left: action.x,
        top: action.y,
        width: action.width ?? 400,
        height: action.height ?? 100,
        rotate: 0,
        defaultFontName: 'Microsoft YaHei',
        defaultColor: action.color ?? '#333333',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      wb.data.id,
    );

    if (!options.silent) {
      // Wait for element fade-in animation
      await delay(WB_DRAW_MS);
    }
  }

  private async executeWbDrawShape(
    action: WbDrawShapeAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    this.stageAPI.whiteboard.addElement(
      {
        id: action.elementId || '',
        type: 'shape',
        viewBox: [1000, 1000] as [number, number],
        path: SHAPE_PATHS[action.shape] ?? SHAPE_PATHS.rectangle,
        left: action.x,
        top: action.y,
        width: action.width,
        height: action.height,
        rotate: 0,
        fill: action.fillColor ?? '#5b9bd5',
        fixedRatio: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      wb.data.id,
    );

    if (!options.silent) {
      // Wait for element fade-in animation
      await delay(WB_DRAW_MS);
    }
  }

  private async executeWbDrawChart(
    action: WbDrawChartAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    this.stageAPI.whiteboard.addElement(
      {
        id: action.elementId || '',
        type: 'chart',
        left: action.x,
        top: action.y,
        width: action.width,
        height: action.height,
        rotate: 0,
        chartType: action.chartType,
        data: action.data,
        themeColors: action.themeColors ?? ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      wb.data.id,
    );

    if (!options.silent) await delay(WB_DRAW_MS);
  }

  private async executeWbDrawLatex(
    action: WbDrawLatexAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    try {
      const html = katex.renderToString(action.latex, {
        throwOnError: false,
        displayMode: true,
        output: 'html',
      });

      this.stageAPI.whiteboard.addElement(
        {
          id: action.elementId || '',
          type: 'latex',
          left: action.x,
          top: action.y,
          width: action.width ?? 400,
          height: action.height ?? 80,
          rotate: 0,
          latex: action.latex,
          html,
          color: action.color ?? '#000000',
          fixedRatio: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        wb.data.id,
      );
    } catch (err) {
      log.warn(`Failed to render latex "${action.latex}":`, err);
      return;
    }

    if (!options.silent) await delay(WB_DRAW_MS);
  }

  private async executeWbDrawTable(
    action: WbDrawTableAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    const rows = action.data.length;
    const cols = rows > 0 ? action.data[0].length : 0;
    if (rows === 0 || cols === 0) return;

    // Build colWidths: equal distribution
    const colWidths = Array(cols).fill(1 / cols);

    // Build TableCell[][] from string[][]
    let cellId = 0;
    const tableData = action.data.map((row) =>
      row.map((text) => ({
        id: `cell_${cellId++}`,
        colspan: 1,
        rowspan: 1,
        text,
      })),
    );

    this.stageAPI.whiteboard.addElement(
      {
        id: action.elementId || '',
        type: 'table',
        left: action.x,
        top: action.y,
        width: action.width,
        height: action.height,
        rotate: 0,
        colWidths,
        cellMinHeight: 36,
        data: tableData,
        outline: action.outline ?? {
          width: 2,
          style: 'solid',
          color: '#eeece1',
        },
        theme: action.theme
          ? {
              color: action.theme.color,
              rowHeader: true,
              rowFooter: false,
              colHeader: false,
              colFooter: false,
            }
          : undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      wb.data.id,
    );

    if (!options.silent) await delay(WB_DRAW_MS);
  }

  private async executeWbDrawLine(
    action: WbDrawLineAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    // Calculate bounding box — left/top is the minimum of start/end coordinates
    const left = Math.min(action.startX, action.endX);
    const top = Math.min(action.startY, action.endY);

    // Convert absolute coordinates to relative coordinates (relative to left/top)
    const start: [number, number] = [action.startX - left, action.startY - top];
    const end: [number, number] = [action.endX - left, action.endY - top];

    this.stageAPI.whiteboard.addElement(
      {
        id: action.elementId || '',
        type: 'line',
        left,
        top,
        width: action.width ?? 2,
        start,
        end,
        style: action.style ?? 'solid',
        color: action.color ?? '#333333',
        points: action.points ?? ['', ''],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      wb.data.id,
    );

    if (!options.silent) {
      // Wait for element fade-in animation
      await delay(WB_DRAW_MS);
    }
  }

  private async executeWbDrawCode(
    action: WbDrawCodeAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    const lines = codeToLines(action.code);
    const suppliedLineIds = (action as WbDrawCodeAction & { lineIds?: string[] }).lineIds;
    if (suppliedLineIds?.length === lines.length) {
      lines.forEach((line, index) => {
        line.id = suppliedLineIds[index];
      });
    }

    this.stageAPI.whiteboard.addElement(
      {
        id: action.elementId || '',
        type: 'code',
        language: action.language,
        lines,
        fileName: action.fileName,
        showLineNumbers: true,
        fontSize: 14,
        left: action.x,
        top: action.y,
        width: action.width ?? 500,
        height: action.height ?? 300,
        rotate: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      wb.data.id,
    );

    if (!options.silent) {
      // Wait for typing animation (base 800ms + 50ms/line, capped at 3s)
      const animMs = wbDrawCodeMs(lines.length);
      await delay(animMs);
    }
  }

  private async executeWbEditCode(
    action: WbEditCodeAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    const elementResult = this.stageAPI.whiteboard.getElement(action.elementId, wb.data.id);
    if (!elementResult.success || !elementResult.data) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const element = elementResult.data as any;
    if (element.type !== 'code') return;

    let lines: CodeLine[] = [...element.lines];
    const newContentLines = action.content ? action.content.split('\n') : [];
    const suppliedLineIds = (action as WbEditCodeAction & { newLineIds?: string[] }).newLineIds;
    const newLineIds =
      suppliedLineIds?.length === newContentLines.length
        ? suppliedLineIds
        : generateLineIds(newContentLines.length);

    switch (action.operation) {
      case 'insert_after': {
        const idx = lines.findIndex((l) => l.id === action.lineId);
        if (idx === -1) return;
        const newLines = newContentLines.map((content, i) => ({ id: newLineIds[i], content }));
        lines.splice(idx + 1, 0, ...newLines);
        break;
      }
      case 'insert_before': {
        const idx = lines.findIndex((l) => l.id === action.lineId);
        if (idx === -1) return;
        const newLines = newContentLines.map((content, i) => ({ id: newLineIds[i], content }));
        lines.splice(idx, 0, ...newLines);
        break;
      }
      case 'delete_lines': {
        if (!action.lineIds?.length) return;
        const deleteSet = new Set(action.lineIds);
        lines = lines.filter((l) => !deleteSet.has(l.id));
        break;
      }
      case 'replace_lines': {
        if (!action.lineIds?.length) return;
        const replaceIds = action.lineIds;
        const firstIdx = lines.findIndex((l) => l.id === replaceIds[0]);
        if (firstIdx === -1) return;
        const deleteSet = new Set(replaceIds);
        lines = lines.filter((l) => !deleteSet.has(l.id));
        const newLines = newContentLines.map((content, i) => ({
          id: i < replaceIds.length ? replaceIds[i] : newLineIds[i],
          content,
        }));
        lines.splice(firstIdx, 0, ...newLines);
        break;
      }
    }

    this.stageAPI.whiteboard.updateElement(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...element, lines } as any,
      wb.data.id,
    );

    if (!options.silent) {
      // Wait for edit animation
      await delay(WB_EDIT_MS);
    }
  }

  private async executeWbDelete(
    action: WbDeleteAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    this.stageAPI.whiteboard.deleteElement(action.elementId, wb.data.id);
    if (!options.silent) await delay(WB_DELETE_MS);
  }

  private async executeWbClear(options: ActionExecutionOptions = {}): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    const elementCount = wb.data.elements?.length || 0;
    if (elementCount === 0) return;

    if (options.silent) {
      this.stageAPI.whiteboard.update({ elements: [] }, wb.data.id);
      useCanvasStore.getState().setWhiteboardClearing(false);
      return;
    }

    // Save snapshot before AI clear (mirrors UI handleClear in index.tsx)
    useWhiteboardHistoryStore.getState().pushSnapshot(wb.data.elements!);

    // Trigger cascade exit animation
    useCanvasStore.getState().setWhiteboardClearing(true);

    // Wait for cascade (base 380ms + 55ms/element, capped at 1400ms)
    const animMs = wbClearMs(elementCount);
    await delay(animMs);

    // Actually remove elements
    this.stageAPI.whiteboard.update({ elements: [] }, wb.data.id);
    useCanvasStore.getState().setWhiteboardClearing(false);
  }

  private async executeWbClose(options: ActionExecutionOptions = {}): Promise<void> {
    useCanvasStore.getState().setWhiteboardOpen(false);
    if (options.silent) return;
    // Wait for close animation (500ms ease-out tween)
    await delay(WB_CLOSE_MS);
  }

  // ==================== Widget Actions ====================

  /** Send message to widget iframe */
  private sendWidgetMessage(type: string, payload: Record<string, unknown>): void {
    if (this.widgetMessageCallback) {
      this.widgetMessageCallback(type, payload);
    } else {
      log.warn(`Widget message callback not set, cannot send: ${type}`);
    }
  }

  /** Execute widget highlight action (quick visual change) */
  private async executeWidgetHighlight(action: WidgetHighlightAction): Promise<void> {
    this.sendWidgetMessage('HIGHLIGHT_ELEMENT', {
      target: action.target,
      content: action.content,
    });
    // Quick delay for visual effect
    await delay(WIDGET_MS);
  }

  /** Execute widget setState action */
  private async executeWidgetSetState(action: WidgetSetStateAction): Promise<void> {
    this.sendWidgetMessage('SET_WIDGET_STATE', { state: action.state, content: action.content });
    // Quick delay for state change to propagate
    await delay(WIDGET_MS);
  }

  /** Execute widget annotation action */
  private async executeWidgetAnnotation(action: WidgetAnnotationAction): Promise<void> {
    this.sendWidgetMessage('ANNOTATE_ELEMENT', {
      target: action.target,
      content: action.content,
    });
    await delay(WIDGET_MS);
  }

  /** Execute widget reveal action */
  private async executeWidgetReveal(action: WidgetRevealAction): Promise<void> {
    this.sendWidgetMessage('REVEAL_ELEMENT', { target: action.target, content: action.content });
    await delay(WIDGET_MS);
  }
}
