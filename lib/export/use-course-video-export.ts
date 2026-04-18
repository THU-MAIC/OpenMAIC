'use client';

/**
 * useCourseVideoExport
 *
 * Drives the course-to-MP4 pipeline:
 *   • Iterates slide scenes only (skips quiz / interactive)
 *   • For speech actions: captures ONE fresh frame, then awaits TTS audio.
 *     The captureStream(5) stream repeats that frame while audio plays —
 *     no need to hammer html2canvas at 10fps for a static slide.
 *   • For spotlight / laser: captures frames at 5fps for ~2s to show the
 *     CSS animation, then clears the effect.
 *   • Skips discussion actions.
 *   • On abort: finalises what was recorded and downloads a "-partial" file.
 */

import { useState, useCallback, useRef } from 'react';
import type { RefObject } from 'react';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction, SpotlightAction, LaserAction } from '@/lib/types/action';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { db } from '@/lib/utils/database';
import { CourseVideoRecorder, downloadBlob } from './course-video-recorder';
import { createLogger } from '@/lib/logger';

const log = createLogger('useCourseVideoExport');

/** How long (ms) to hold a spotlight / laser while capturing frames */
const POINTER_HOLD_MS = 2000;

/** Brief yield after spotlight/laser so useLayoutEffect measurement commits (Spotlight). */
const POINTER_OVERLAY_SETTLE_MS = 120;

/** DOM settle time after scene navigation (ms) */
const SCENE_SETTLE_MS = 500;

/** ~1.5 minutes per slide — mirrors ClassroomTimer */
const MINUTES_PER_SLIDE = 1.5;

export interface ExportProgress {
  sceneIndex: number;
  sceneTotal: number;
  sceneTitle: string;
}

export interface UseCourseVideoExportReturn {
  isExporting: boolean;
  progress: ExportProgress | null;
  startExport: () => Promise<void>;
  /** Stop the export loop and download whatever has been recorded so far. */
  abortExport: () => void;
}

export function useCourseVideoExport(
  slideRef: RefObject<HTMLElement | null>,
): UseCourseVideoExportReturn {
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const recorderRef = useRef<CourseVideoRecorder | null>(null);
  const cancelledRef = useRef(false);

  // ── Abort: stop loop but still finalise + download partial video ──────────
  const abortExport = useCallback(() => {
    if (!recorderRef.current) return;
    cancelledRef.current = true;
    recorderRef.current.requestAbort();
  }, []);

  // ── Main export ───────────────────────────────────────────────────────────
  const startExport = useCallback(async () => {
    const slideEl = slideRef.current;
    if (!slideEl) {
      log.warn('slideRef not attached');
      return;
    }

    // Filter to slide scenes only; keep original order
    const allScenes = useStageStore.getState().scenes;
    const slideScenes = allScenes.filter((s): s is Scene => s.type === 'slide');

    if (slideScenes.length === 0) {
      log.warn('No slide scenes found');
      return;
    }

    const setCurrentSceneId = useStageStore.getState().setCurrentSceneId;

    cancelledRef.current = false;
    setIsExporting(true);

    const recorder = new CourseVideoRecorder();
    recorderRef.current = recorder;
    recorder.start();

    try {
      for (let si = 0; si < slideScenes.length; si++) {
        if (cancelledRef.current) break;

        const scene = slideScenes[si];

        setProgress({
          sceneIndex: si + 1,
          sceneTotal: slideScenes.length,
          sceneTitle: scene.title ?? `Scene ${si + 1}`,
        });

        // Navigate to scene — React re-renders on next tick
        setCurrentSceneId(scene.id);
        // Wait for React to commit + browser to paint (SCENE_SETTLE_MS >> rAF)
        await sleep(SCENE_SETTLE_MS);
        if (cancelledRef.current) break;

        // Time remaining label — mirrors ClassroomTimer which uses overall index
        const overallIndex = allScenes.findIndex((s) => s.id === scene.id);
        const slidesRemaining = Math.max(0, allScenes.length - overallIndex);
        const minsLeft = Math.ceil(slidesRemaining * MINUTES_PER_SLIDE);
        const timeLabel = `${minsLeft} min left`;

        // Capture the first frame of this slide BEFORE processing actions
        // so there's at least one frame even if all actions are discussions.
        await recorder.captureFrame(slideEl, timeLabel);
        if (cancelledRef.current) break;

        const actions = scene.actions ?? [];
        for (const action of actions) {
          if (cancelledRef.current) break;

          switch (action.type) {
            case 'speech': {
              const speechAction = action as SpeechAction;

              // Capture one fresh frame — the slide content for this speech line
              // may differ (e.g. previous spotlight was just cleared)
              await recorder.captureFrame(slideEl, timeLabel);
              if (cancelledRef.current) break;

              const blob = await loadAudioBlob(speechAction);
              if (blob && !cancelledRef.current) {
                // Hold the captured frame while audio plays.
                // captureStream(5) repeats the canvas at 5fps automatically.
                await recorder.playAudio(blob);
              } else if (!cancelledRef.current) {
                // No pre-generated audio — hold slide for estimated reading time
                await recorder.captureFor(
                  slideEl,
                  estimateReadingMs(speechAction.text),
                  timeLabel,
                );
              }
              break;
            }

            case 'spotlight': {
              const { elementId, dimOpacity } = action as SpotlightAction;
              useCanvasStore.getState().setSpotlight(elementId, { dimness: dimOpacity });
              await sleep(POINTER_OVERLAY_SETTLE_MS);
              await recorder.captureFor(slideEl, POINTER_HOLD_MS, timeLabel);
              useCanvasStore.getState().clearSpotlight();
              // Capture one frame showing the cleared state
              await recorder.captureFrame(slideEl, timeLabel);
              break;
            }

            case 'laser': {
              const { elementId, color } = action as LaserAction;
              useCanvasStore.getState().setLaser(elementId, { color });
              await sleep(POINTER_OVERLAY_SETTLE_MS);
              await recorder.captureFor(slideEl, POINTER_HOLD_MS, timeLabel);
              useCanvasStore.getState().clearLaser();
              await recorder.captureFrame(slideEl, timeLabel);
              break;
            }

            case 'discussion':
              // Skip — requires live AI responses
              break;

            default:
              // wb_* / play_video: just hold the current frame
              break;
          }
        }
      }
    } catch (err) {
      log.error('Export loop error:', err);
      // Hard-cancel on errors — nothing to save
      recorder.cancel();
      recorderRef.current = null;
      setIsExporting(false);
      setProgress(null);
      return;
    }

    // ── Finalise — runs for both complete AND aborted exports ─────────────
    const wasAborted = cancelledRef.current;
    try {
      const blob = await recorder.stop();
      if (blob.size > 0) {
        const stageName = useStageStore.getState().stage?.name ?? 'course';
        const suffix = wasAborted ? '-partial' : '';
        downloadBlob(blob, `${slugify(stageName)}${suffix}.mp4`);
        log.debug(wasAborted ? 'Partial export saved.' : 'Full export saved.');
      } else {
        log.warn('Recorder produced empty blob — nothing to download.');
      }
    } catch (err) {
      log.error('Failed to finalise recording:', err);
    } finally {
      recorderRef.current = null;
      setIsExporting(false);
      setProgress(null);
    }
  }, [slideRef]);

  return { isExporting, progress, startExport, abortExport };
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function loadAudioBlob(action: SpeechAction): Promise<Blob | null> {
  if (action.audioUrl) {
    try {
      const res = await fetch(action.audioUrl);
      if (res.ok) return await res.blob();
    } catch (err) {
      log.warn('Failed to fetch audioUrl:', err);
    }
  }
  if (action.audioId) {
    try {
      const record = await db.audioFiles.get(action.audioId);
      if (record?.blob) return record.blob;
    } catch (err) {
      log.warn('Failed to load audio from IndexedDB:', err);
    }
  }
  return null;
}

function estimateReadingMs(text: string): number {
  const cjkCount = (
    text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []
  ).length;
  const isCJK = cjkCount > text.length * 0.3;
  return isCJK
    ? Math.max(2000, text.length * 150)
    : Math.max(2000, text.split(/\s+/).filter(Boolean).length * 240);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'course';
}
