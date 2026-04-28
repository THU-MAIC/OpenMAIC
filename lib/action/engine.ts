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
import { getClientTranslation } from '@/lib/i18n';
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
import type { CodeLine } from '@/lib/types/slides';
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

/** Default duration (ms) before fire-and-forget effects auto-clear */
const EFFECT_AUTO_CLEAR_MS = 5000;

/** Callback for sending messages to widget iframe */
export type WidgetMessageCallback = (type: string, payload: Record<string, unknown>) => void;

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
  async execute(action: Action): Promise<void> {
    // Auto-open whiteboard if a draw/clear/delete action is attempted while it's closed
    if (action.type.startsWith('wb_') && action.type !== 'wb_open' && action.type !== 'wb_close') {
      await this.ensureWhiteboardOpen();
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
        return this.executePlayVideo(action as PlayVideoAction);

      // Synchronous
      case 'speech':
        return this.executeSpeech(action);
      case 'wb_open':
        return this.executeWbOpen();
      case 'wb_draw_text':
        return this.executeWbDrawText(action);
      case 'wb_draw_shape':
        return this.executeWbDrawShape(action);
      case 'wb_draw_chart':
        return this.executeWbDrawChart(action);
      case 'wb_draw_latex':
        return this.executeWbDrawLatex(action);
      case 'wb_draw_table':
        return this.executeWbDrawTable(action);
      case 'wb_draw_line':
        return this.executeWbDrawLine(action as WbDrawLineAction);
      case 'wb_draw_code':
        return this.executeWbDrawCode(action as WbDrawCodeAction);
      case 'wb_edit_code':
        return this.executeWbEditCode(action as WbEditCodeAction);
      case 'wb_clear':
        return this.executeWbClear();
      case 'wb_delete':
        return this.executeWbDelete(action as WbDeleteAction);
      case 'wb_close':
        return this.executeWbClose();
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

  private async executePlayVideo(action: PlayVideoAction): Promise<void> {
    // Resolve the video element's src to a media placeholder ID (e.g. gen_vid_1).
    // action.elementId is the slide element ID (e.g. video_abc123), but the media
    // store is keyed by placeholder IDs, so we need to bridge the two.
    const placeholderId = this.resolveMediaPlaceholderId(action.elementId);

    if (placeholderId) {
      const task = useMediaGenerationStore.getState().getTask(placeholderId);
      if (task && task.status !== 'done') {
        // Wait for media to be ready (or fail)
        await new Promise<void>((resolve) => {
          const unsubscribe = useMediaGenerationStore.subscribe((state) => {
            const t = state.tasks[placeholderId];
            if (!t || t.status === 'done' || t.status === 'failed') {
              unsubscribe();
              resolve();
            }
          });
          // Check again in case it resolved between getState and subscribe
          const current = useMediaGenerationStore.getState().tasks[placeholderId];
          if (!current || current.status === 'done' || current.status === 'failed') {
            unsubscribe();
            resolve();
          }
        });

        // If failed, skip playback
        if (useMediaGenerationStore.getState().tasks[placeholderId]?.status === 'failed') {
          return;
        }
      }
    }

    useCanvasStore.getState().playVideo(action.elementId);

    // Wait until the video finishes playing, with a safety timeout to prevent
    // the playback engine from hanging indefinitely if the video element is
    // invalid or the state change is missed.
    return new Promise<void>((resolve) => {
      const MAX_VIDEO_WAIT_MS = 5 * 60 * 1000; // 5 minutes
      const timeout = setTimeout(() => {
        unsubscribe();
        log.warn(`[playVideo] Timeout waiting for video ${action.elementId} to finish`);
        resolve();
      }, MAX_VIDEO_WAIT_MS);
      const unsubscribe = useCanvasStore.subscribe((state) => {
        if (state.playingVideoElementId !== action.elementId) {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
      if (useCanvasStore.getState().playingVideoElementId !== action.elementId) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  }

  // ==================== Helpers — Media Resolution ====================

  /**
   * Look up a video/image element's src in the current stage's scenes.
   * Returns the src if it's a media placeholder ID (gen_vid_*, gen_img_*), null otherwise.
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
          canvas?: { elements?: Array<{ id: string; src?: string }> };
        }
      )?.canvas?.elements;
      if (!Array.isArray(elements)) continue;
      const el = elements.find((e: { id: string }) => e.id === elementId);
      if (el && 'src' in el && typeof el.src === 'string' && isMediaPlaceholder(el.src)) {
        return el.src;
      }
    }
    return null;
  }

  // ==================== Synchronous — Whiteboard ====================

  /** Auto-open the whiteboard if it's not already open */
  private async ensureWhiteboardOpen(): Promise<void> {
    if (!useCanvasStore.getState().whiteboardOpen) {
      await this.executeWbOpen();
    }
  }

  private async executeWbOpen(): Promise<void> {
    // Ensure a whiteboard exists
    this.stageAPI.whiteboard.get();
    useCanvasStore.getState().setWhiteboardOpen(true);
    // Wait for open animation to complete (slow spring: stiffness 120, damping 18, mass 1.2)
    await delay(2000);
  }

  private async executeWbDrawText(action: WbDrawTextAction): Promise<void> {
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

    // Wait for element fade-in animation
    await delay(800);
  }

  private async executeWbDrawShape(action: WbDrawShapeAction): Promise<void> {
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

    // Wait for element fade-in animation
    await delay(800);
  }

  private async executeWbDrawChart(action: WbDrawChartAction): Promise<void> {
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

    await delay(800);
  }

  private async executeWbDrawLatex(action: WbDrawLatexAction): Promise<void> {
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

    await delay(800);
  }

  private async executeWbDrawTable(action: WbDrawTableAction): Promise<void> {
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

    await delay(800);
  }

  private async executeWbDrawLine(action: WbDrawLineAction): Promise<void> {
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

    // Wait for element fade-in animation
    await delay(800);
  }

  private async executeWbDrawCode(action: WbDrawCodeAction): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    const lines = codeToLines(action.code);

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

    // Wait for typing animation: base 800ms + 50ms per line, capped at 3s
    const animMs = Math.min(800 + lines.length * 50, 3000);
    await delay(animMs);
  }

  private async executeWbEditCode(action: WbEditCodeAction): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    const elementResult = this.stageAPI.whiteboard.getElement(action.elementId, wb.data.id);
    if (!elementResult.success || !elementResult.data) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const element = elementResult.data as any;
    if (element.type !== 'code') return;

    let lines: CodeLine[] = [...element.lines];
    const newContentLines = action.content ? action.content.split('\n') : [];
    const newLineIds = generateLineIds(newContentLines.length);

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

    // Wait for edit animation
    await delay(600);
  }

  private async executeWbDelete(action: WbDeleteAction): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    this.stageAPI.whiteboard.deleteElement(action.elementId, wb.data.id);
    await delay(300);
  }

  private async executeWbClear(): Promise<void> {
    const wb = this.stageAPI.whiteboard.get();
    if (!wb.success || !wb.data) return;

    const elementCount = wb.data.elements?.length || 0;
    if (elementCount === 0) return;

    // Save snapshot before AI clear (mirrors UI handleClear in index.tsx)
    useWhiteboardHistoryStore.getState().pushSnapshot(wb.data.elements!);

    // Trigger cascade exit animation
    useCanvasStore.getState().setWhiteboardClearing(true);

    // Wait for cascade: base 380ms + 55ms per element, capped at 1400ms
    const animMs = Math.min(380 + elementCount * 55, 1400);
    await delay(animMs);

    // Actually remove elements
    this.stageAPI.whiteboard.update({ elements: [] }, wb.data.id);
    useCanvasStore.getState().setWhiteboardClearing(false);
  }

  private async executeWbClose(): Promise<void> {
    useCanvasStore.getState().setWhiteboardOpen(false);
    // Wait for close animation (500ms ease-out tween)
    await delay(700);
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
    });
    // Quick delay for visual effect
    await delay(300);
  }

  /** Execute widget setState action */
  private async executeWidgetSetState(action: WidgetSetStateAction): Promise<void> {
    this.sendWidgetMessage('SET_WIDGET_STATE', { state: action.state });
    // Quick delay for state change to propagate
    await delay(300);
  }

  /** Execute widget annotation action */
  private async executeWidgetAnnotation(action: WidgetAnnotationAction): Promise<void> {
    this.sendWidgetMessage('ANNOTATE_ELEMENT', {
      target: action.target,
    });
    await delay(300);
  }

  /** Execute widget reveal action */
  private async executeWidgetReveal(action: WidgetRevealAction): Promise<void> {
    this.sendWidgetMessage('REVEAL_ELEMENT', { target: action.target });
    await delay(300);
  }
}
