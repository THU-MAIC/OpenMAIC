'use client';

import { useCallback, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { slideToPng } from '@maic/renderer/snapshot';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  BROWSER_NATIVE_TTS_PROVIDER_ID,
  isTTSProviderEnabled,
} from '@/lib/audio/provider-enablement';
import { resolveAgentVoiceOptions, pickNarratorAgent } from '@/lib/audio/agent-voice';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import { db } from '@/lib/utils/database';
import type { SpeechAction } from '@/lib/types/action';
import type { Scene, SlideContent } from '@/lib/types/stage';

type RendererSlide = Parameters<typeof slideToPng>[0];

const EXPORT_FPS = 30;
const DEFAULT_SCENE_MS = 2500;
const BASE_FRAME_WIDTH = 1280;
const BASE_FRAME_HEIGHT = 720;

export type VideoCourseExportResolutionId = '720p' | '1080p' | '1440p' | '2160p';

export interface VideoCourseExportResolution {
  id: VideoCourseExportResolutionId;
  label: string;
  width: number;
  height: number;
}

export const VIDEO_COURSE_EXPORT_RESOLUTIONS: VideoCourseExportResolution[] = [
  { id: '720p', label: '720p', width: 1280, height: 720 },
  { id: '1080p', label: '1080p', width: 1920, height: 1080 },
  { id: '1440p', label: '2K', width: 2560, height: 1440 },
  { id: '2160p', label: '4K', width: 3840, height: 2160 },
];

export const DEFAULT_VIDEO_COURSE_EXPORT_RESOLUTION_ID: VideoCourseExportResolutionId = '1080p';

export interface ExportVideoCourseOptions {
  resolutionId?: VideoCourseExportResolutionId;
}

type VideoCourseTrack =
  | {
      type: 'file';
      field: string;
      durationMs?: number;
      mimeType?: string;
      required?: boolean;
    }
  | {
      type: 'url';
      url: string;
      durationMs?: number;
      mimeType?: string;
      required?: boolean;
    }
  | {
      type: 'silence';
      durationMs: number;
    };

interface VideoCourseManifest {
  fileName: string;
  width: number;
  height: number;
  fps: number;
  scenes: Array<{
    title: string;
    imageField: string;
    fallbackMs: number;
    tracks: VideoCourseTrack[];
  }>;
}

interface AudioAsset {
  blob: Blob;
  durationMs?: number;
  mimeType?: string;
  extension: string;
}

function safeFileName(name: string | undefined, fallback: string): string {
  return (name || fallback).replace(/[\\/:*?"<>|]/g, '_') || fallback;
}

function videoCourseFileName(
  name: string | undefined,
  resolution: VideoCourseExportResolution,
): string {
  return `${safeFileName(name, 'course')}-${resolution.label}`;
}

function errorPayloadText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function compactErrorMessage(value: string): string {
  const normalized = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  return normalized.length > 1800 ? `...${normalized.slice(normalized.length - 1800)}` : normalized;
}

function estimateSpeechMs(text: string): number {
  const cjkCount = (
    text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []
  ).length;
  const isCJK = cjkCount > text.length * 0.3;
  const rawMs = isCJK
    ? Math.max(2000, text.length * 150)
    : Math.max(2000, text.split(/\s+/).filter(Boolean).length * 240);
  return Math.round(rawMs);
}

function audioMimeFromFormat(format?: string, blobType?: string): string {
  if (blobType) return blobType;
  switch ((format || '').toLowerCase()) {
    case 'wav':
      return 'audio/wav';
    case 'webm':
      return 'audio/webm';
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'ogg':
      return 'audio/ogg';
    case 'mp3':
    case 'mpeg':
    default:
      return 'audio/mpeg';
  }
}

function audioExtFromMime(mimeType?: string): string {
  if (!mimeType) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  return 'mp3';
}

async function blobFromDataUrl(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return await res.blob();
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Unable to render placeholder frame'));
    }, 'image/png');
  });
}

function resolveVideoCourseExportResolution(
  resolutionId?: VideoCourseExportResolutionId,
): VideoCourseExportResolution {
  return (
    VIDEO_COURSE_EXPORT_RESOLUTIONS.find((resolution) => resolution.id === resolutionId) ??
    VIDEO_COURSE_EXPORT_RESOLUTIONS.find(
      (resolution) => resolution.id === DEFAULT_VIDEO_COURSE_EXPORT_RESOLUTION_ID,
    )!
  );
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): number {
  const words = text.split(/\s+/);
  const hasSpaces = words.length > 1;
  const units = hasSpaces ? words : Array.from(text);
  let line = '';
  let lines = 0;

  for (const unit of units) {
    const next = hasSpaces ? (line ? `${line} ${unit}` : unit) : line + unit;
    if (ctx.measureText(next).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      y += lineHeight;
      lines++;
      line = unit;
      if (lines >= maxLines - 1) break;
    } else {
      line = next;
    }
  }

  if (line && lines < maxLines) {
    ctx.fillText(line, x, y);
    y += lineHeight;
  }
  return y;
}

async function createStaticSceneFrame(
  scene: Scene,
  index: number,
  resolution: VideoCourseExportResolution,
): Promise<Blob> {
  const { width, height } = resolution;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.scale(width / BASE_FRAME_WIDTH, height / BASE_FRAME_HEIGHT);

  const accent =
    scene.type === 'quiz'
      ? '#7c3aed'
      : scene.type === 'interactive'
        ? '#2563eb'
        : scene.type === 'pbl'
          ? '#059669'
          : '#f59e0b';
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, BASE_FRAME_WIDTH, BASE_FRAME_HEIGHT);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 14, BASE_FRAME_HEIGHT);

  ctx.fillStyle = '#e5e7eb';
  ctx.fillRect(120, 142, BASE_FRAME_WIDTH - 240, 2);

  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect(120, 96, 150, 44, 22);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 22px "Noto Sans SC", "Microsoft YaHei", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(`第 ${index + 1} 页`, 150, 118);

  ctx.fillStyle = '#111827';
  ctx.font = '700 52px "Noto Sans SC", "Microsoft YaHei", sans-serif';
  ctx.textBaseline = 'alphabetic';
  drawWrappedText(ctx, scene.title || '课程页面', 120, 250, BASE_FRAME_WIDTH - 240, 68, 3);

  ctx.fillStyle = '#6b7280';
  ctx.font = '400 24px "Noto Sans SC", "Microsoft YaHei", sans-serif';
  const typeLabel =
    scene.type === 'quiz'
      ? '小测页面'
      : scene.type === 'interactive'
        ? '互动页面'
        : scene.type === 'pbl'
          ? '项目页面'
          : '课程页面';
  ctx.fillText(typeLabel, 120, 520);
  ctx.restore();

  return await canvasToBlob(canvas);
}

async function renderSceneFrame(
  scene: Scene,
  index: number,
  resolution: VideoCourseExportResolution,
): Promise<Blob> {
  if (scene.content.type === 'slide') {
    const slide = (scene.content as SlideContent).canvas as unknown as RendererSlide;
    const image = await slideToPng(slide, {
      width: resolution.width,
      pixelRatio: 1,
      backgroundColor: '#ffffff',
      format: 'blob',
      timeoutMs: 10000,
    });
    return typeof image === 'string' ? await blobFromDataUrl(image) : image;
  }

  return await createStaticSceneFrame(scene, index, resolution);
}

async function resolveSpeechAudioFromDb(audioId?: string): Promise<AudioAsset | null> {
  if (!audioId) return null;
  const record = await db.audioFiles.get(audioId);
  if (!record) return null;
  const mimeType = audioMimeFromFormat(record.format, record.blob.type);
  return {
    blob: record.blob,
    durationMs: record.duration ? Math.round(record.duration * 1000) : undefined,
    mimeType,
    extension: audioExtFromMime(mimeType),
  };
}

function getSpeechActions(scene: Scene): SpeechAction[] {
  return (scene.actions ?? []).filter((action): action is SpeechAction => action.type === 'speech');
}

function getSpeechExportAudioId(scene: Scene, speech: SpeechAction, speechIndex: number): string {
  return speech.audioId || `tts_export_s${scene.order}_${speech.id || speechIndex}`;
}

function isExportableAudioUrl(audioUrl?: string): audioUrl is string {
  if (!audioUrl) return false;
  try {
    const parsed = new URL(
      audioUrl,
      typeof window === 'undefined' ? 'http://localhost' : window.location.href,
    );
    return (
      parsed.pathname.startsWith('/api/classroom-media/') && parsed.pathname.includes('/audio/')
    );
  } catch {
    return false;
  }
}

async function hasExistingExportableNarration(
  scene: Scene,
  speech: SpeechAction,
  speechIndex: number,
): Promise<boolean> {
  if (isExportableAudioUrl(speech.audioUrl)) return true;

  const exportAudioId = getSpeechExportAudioId(scene, speech, speechIndex);
  if (await db.audioFiles.get(exportAudioId)) return true;
  if (speech.audioId && speech.audioId !== exportAudioId) {
    return !!(await db.audioFiles.get(speech.audioId));
  }
  return false;
}

async function generateSpeechAudioForExport(
  audioId: string,
  text: string,
  language?: string,
): Promise<AudioAsset | null> {
  const settings = useSettingsStore.getState();
  if (settings.ttsProviderId === BROWSER_NATIVE_TTS_PROVIDER_ID) return null;
  if (
    !isTTSProviderEnabled(
      settings.ttsProviderId,
      settings.ttsProvidersConfig?.[settings.ttsProviderId],
    )
  ) {
    return null;
  }

  const ttsProviderConfig = settings.ttsProvidersConfig?.[settings.ttsProviderId];
  const teacher = pickNarratorAgent(useAgentRegistry.getState().listAgents());
  const providerOptions = await resolveAgentVoiceOptions(teacher, {
    providerId: settings.ttsProviderId,
    providerConfig: ttsProviderConfig,
    voiceId: settings.ttsVoice,
    language,
  });

  const response = await fetch('/api/generate/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      audioId,
      ttsProviderId: settings.ttsProviderId,
      ttsModelId: ttsProviderConfig?.modelId,
      ttsVoice: settings.ttsVoice,
      ttsSpeed: settings.ttsSpeed,
      ttsApiKey: ttsProviderConfig?.apiKey || undefined,
      ttsBaseUrl:
        ttsProviderConfig?.baseUrl || ttsProviderConfig?.customDefaultBaseUrl || undefined,
      ttsProviderOptions: providerOptions,
    }),
  });

  const data = await response
    .json()
    .catch(() => ({ success: false, error: response.statusText || 'Invalid TTS response' }));
  if (!response.ok || !data.success || !data.base64 || !data.format) {
    throw new Error(data.details || data.error || `TTS request failed: HTTP ${response.status}`);
  }

  const binary = atob(data.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: `audio/${data.format}` });
  await db.audioFiles.put({
    id: audioId,
    blob,
    format: data.format,
    createdAt: Date.now(),
  });

  const mimeType = audioMimeFromFormat(data.format, blob.type);
  return {
    blob,
    mimeType,
    extension: audioExtFromMime(mimeType),
  };
}

export function useExportVideoCourse() {
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const { t } = useI18n();

  const exportVideoCourse = useCallback(
    async (options?: ExportVideoCourseOptions) => {
      if (exportingRef.current) return;
      const { stage, scenes } = useStageStore.getState();
      if (!stage?.id || scenes.length === 0) return;

      exportingRef.current = true;
      setExporting(true);
      const toastId = toast.loading(t('export.videoPreparing'));

      try {
        const orderedScenes = [...scenes].sort((a, b) => a.order - b.order);
        const exportResolution = resolveVideoCourseExportResolution(options?.resolutionId);
        const settings = useSettingsStore.getState();
        const isBrowserNativeTTS = settings.ttsProviderId === BROWSER_NATIVE_TTS_PROVIDER_ID;
        const speechEntries = orderedScenes.flatMap((scene) =>
          getSpeechActions(scene).map((speech, speechIndex) => ({ scene, speech, speechIndex })),
        );

        if (isBrowserNativeTTS && speechEntries.length > 0) {
          let hasExistingAudio = false;
          for (const { scene, speech, speechIndex } of speechEntries) {
            if (await hasExistingExportableNarration(scene, speech, speechIndex)) {
              hasExistingAudio = true;
              break;
            }
          }
          if (!hasExistingAudio) {
            throw new Error(t('export.videoBrowserTTSUnsupported'));
          }
        }

        const formData = new FormData();
        let narrationTrackCount = 0;
        let totalSpeechCount = 0;
        let failedNarrationCount = 0;
        const manifest: VideoCourseManifest = {
          fileName: videoCourseFileName(stage.name, exportResolution),
          width: exportResolution.width,
          height: exportResolution.height,
          fps: EXPORT_FPS,
          scenes: [],
        };

        for (let sceneIndex = 0; sceneIndex < orderedScenes.length; sceneIndex++) {
          const scene = orderedScenes[sceneIndex];
          toast.loading(
            t('export.videoPreparingProgress', {
              current: sceneIndex + 1,
              total: orderedScenes.length,
            }),
            { id: toastId },
          );

          const imageBlob = await renderSceneFrame(scene, sceneIndex, exportResolution);
          const imageField = `image-${sceneIndex}`;
          formData.append(
            imageField,
            imageBlob,
            `scene-${String(sceneIndex + 1).padStart(3, '0')}.png`,
          );

          const tracks: VideoCourseTrack[] = [];
          const speechActions = getSpeechActions(scene);
          totalSpeechCount += speechActions.length;

          for (let speechIndex = 0; speechIndex < speechActions.length; speechIndex++) {
            const speech = speechActions[speechIndex];
            const exportAudioId = getSpeechExportAudioId(scene, speech, speechIndex);
            const audioUrl = isExportableAudioUrl(speech.audioUrl) ? speech.audioUrl : undefined;
            let audio = await resolveSpeechAudioFromDb(exportAudioId);
            if (!audio && speech.audioId && speech.audioId !== exportAudioId) {
              audio = await resolveSpeechAudioFromDb(speech.audioId);
            }
            let generationFailed = false;
            if (!audio && !audioUrl && !isBrowserNativeTTS) {
              try {
                toast.loading(
                  t('export.videoGeneratingNarration', {
                    current: sceneIndex + 1,
                    total: orderedScenes.length,
                  }),
                  { id: toastId },
                );
                audio = await generateSpeechAudioForExport(
                  exportAudioId,
                  speech.text,
                  stage.languageDirective,
                );
              } catch {
                generationFailed = true;
                failedNarrationCount++;
              }
            }
            if (audio) {
              narrationTrackCount++;
              const field = `audio-${sceneIndex}-${speechIndex}`;
              formData.append(field, audio.blob, `${field}.${audio.extension}`);
              tracks.push({
                type: 'file',
                field,
                durationMs: audio.durationMs,
                mimeType: audio.mimeType,
                required: true,
              });
            } else if (audioUrl) {
              narrationTrackCount++;
              tracks.push({
                type: 'url',
                url: audioUrl,
                durationMs: estimateSpeechMs(speech.text),
                required: true,
              });
            } else {
              if (!generationFailed) failedNarrationCount++;
              tracks.push({
                type: 'silence',
                durationMs: estimateSpeechMs(speech.text),
              });
            }
          }

          if (tracks.length === 0) {
            tracks.push({ type: 'silence', durationMs: DEFAULT_SCENE_MS });
          }

          manifest.scenes.push({
            title: scene.title,
            imageField,
            fallbackMs: tracks.reduce((sum, track) => sum + (track.durationMs ?? 0), 0),
            tracks,
          });
        }

        if (totalSpeechCount > 0 && narrationTrackCount === 0) {
          throw new Error(t('export.videoNarrationUnavailable'));
        }

        formData.append('manifest', JSON.stringify(manifest));
        toast.loading(t('export.videoRendering'), { id: toastId });

        const res = await fetch('/api/export/video-course', {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          const summary = errorPayloadText(payload?.error);
          const details = errorPayloadText(payload?.details);
          const reason = compactErrorMessage([summary, details].filter(Boolean).join('\n'));
          throw new Error(
            reason ? t('export.videoRenderFailedWithReason', { reason }) : t('export.exportFailed'),
          );
        }

        const blob = await res.blob();
        saveAs(blob, `${videoCourseFileName(stage.name, exportResolution)}.mp4`);
        toast.success(t('export.exportSuccess'), { id: toastId });
        if (narrationTrackCount === 0) {
          toast.warning(t('export.videoNoNarration'));
        } else if (failedNarrationCount > 0) {
          toast.warning(t('export.videoPartialNarration', { count: failedNarrationCount }));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : t('export.exportFailed');
        toast.error(message, { id: toastId });
      } finally {
        exportingRef.current = false;
        setExporting(false);
      }
    },
    [t],
  );

  return { exporting, exportVideoCourse };
}
