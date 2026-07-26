import type { Action, SpeechAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import { db, type AudioFileRecord } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';
import { uploadCourseBlob } from '@/lib/course-assets/client';

const log = createLogger('AudioPublish');

export interface PublishedAudioItem {
  sceneId: string;
  sceneOrder?: number;
  actionId?: string;
  audioId: string;
  audioUrl?: string;
}

export interface MissingAudioItem {
  sceneId: string;
  sceneOrder?: number;
  actionId?: string;
  audioId: string;
  reason: string;
}

export interface FailedAudioItem {
  sceneId: string;
  sceneOrder?: number;
  actionId?: string;
  audioId: string;
  error: string;
}

/** New: items that were regenerated via TTS during publish (no prior blob existed). */
export interface RegeneratedAudioItem {
  sceneId: string;
  sceneOrder?: number;
  actionId?: string;
  audioId: string;
  audioUrl: string;
  textLength: number;
}

export interface PublishSceneAudioAssetsResult {
  scenes: Scene[];
  uploaded: PublishedAudioItem[];
  skipped: PublishedAudioItem[];
  missing: MissingAudioItem[];
  failed: FailedAudioItem[];
  regenerated: RegeneratedAudioItem[];
}

function isSpeechAction(action: Action): action is SpeechAction {
  return action.type === 'speech';
}

function normalizeAudioFormat(format?: string): string {
  const normalized = (format || 'mp3').trim().toLowerCase();
  if (!normalized) return 'mp3';
  if (normalized === 'mpeg') return 'mp3';
  return normalized.replace(/^\./, '');
}

function contentTypeForAudio(format?: string): string {
  const normalized = normalizeAudioFormat(format);
  if (normalized === 'mp3') return 'audio/mpeg';
  if (normalized === 'wav') return 'audio/wav';
  if (normalized === 'ogg') return 'audio/ogg';
  if (normalized === 'webm') return 'audio/webm';
  if (normalized === 'm4a') return 'audio/mp4';
  return `audio/${normalized}`;
}

async function uploadAudioRecordToCloud(input: {
  stageId: string;
  audioId: string;
  record: AudioFileRecord;
}): Promise<string> {
  const { stageId, record } = input;

  return uploadCourseBlob(stageId, 'audio', record.blob);
}

/** Upload a raw ArrayBuffer/Blob directly to Supabase Storage. */
async function uploadBlobToCloud(input: {
  stageId: string;
  audioId: string;
  data: ArrayBuffer;
  format: string;
}): Promise<string> {
  const { stageId, data, format } = input;
  return uploadCourseBlob(stageId, 'audio', new Blob([data], { type: contentTypeForAudio(format) }));
}

/**
 * Resolve TTS configuration for regeneration during publish.
 *
 * Priority (strict):
 *   1. stage.teacherVoiceConfig — course-level authoritative voice
 *   2. settings store — user-configured TTS provider (fallback only)
 *   3. minimax-tts / female-yujie — hard fallback
 */
export interface TeacherVoiceConfig {
  providerId?: string;
  voiceId?: string;
  modelId?: string;
}

async function resolveTtsConfigForPublish(
  teacherVoiceConfig?: TeacherVoiceConfig | null,
  sceneId?: string,
): Promise<{
  providerId: string;
  voice: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  source: 'stage.teacherVoiceConfig' | 'settings' | 'provider-default';
}> {
  // ── Priority 1: stage.teacherVoiceConfig ──
  if (teacherVoiceConfig?.providerId && teacherVoiceConfig.voiceId) {
    const providerId = `${teacherVoiceConfig.providerId}-tts`;
    const voice = teacherVoiceConfig.voiceId;
    const modelId = teacherVoiceConfig.modelId || 'speech-2.8-hd';

    // Read apiKey/baseUrl from settings store for the resolved provider.
    let apiKey: string | undefined;
    let baseUrl: string | undefined;
    try {
      const { useSettingsStore } = await import('@/lib/store/settings');
      const s = useSettingsStore.getState();
      const cfg = s.ttsProvidersConfig as unknown as Record<string, { apiKey?: string; baseUrl?: string; customDefaultBaseUrl?: string; modelId?: string }>;
      const providerCfg = cfg?.[providerId];
      apiKey = providerCfg?.apiKey;
      baseUrl = providerCfg?.baseUrl || providerCfg?.customDefaultBaseUrl;
    } catch {
      // Settings store unavailable — TTS API may reject, but we log the source correctly.
    }

    const result = { providerId, voice, modelId, apiKey, baseUrl, source: 'stage.teacherVoiceConfig' as const };
    console.info('[MOBILE PUBLISH][TTS Voice Resolve]', JSON.stringify({
      sceneId: sceneId ?? '(unknown)',
      source: result.source,
      providerId: result.providerId,
      voiceId: result.voice,
      modelId: result.modelId,
    }));
    return result;
  }

  // ── Priority 2: settings store ──
  try {
    const { useSettingsStore } = await import('@/lib/store/settings');
    const settings = useSettingsStore.getState();

    const providerId = settings.ttsProviderId || 'minimax-tts';
    const voice = settings.ttsVoice || 'female-yujie';
    const cfg = settings.ttsProvidersConfig as unknown as Record<string, { apiKey?: string; baseUrl?: string; customDefaultBaseUrl?: string; modelId?: string }>;
    const providerCfg = cfg?.[providerId];
    const modelId = providerCfg?.modelId || 'speech-2.8-hd';
    const apiKey = providerCfg?.apiKey;
    const baseUrl = providerCfg?.baseUrl || providerCfg?.customDefaultBaseUrl;

    const result = { providerId, voice, modelId, apiKey, baseUrl, source: 'settings' as const };
    console.info('[MOBILE PUBLISH][TTS Voice Resolve]', JSON.stringify({
      sceneId: sceneId ?? '(unknown)',
      source: result.source,
      providerId: result.providerId,
      voiceId: result.voice,
      modelId: result.modelId,
    }));
    return result;
  } catch {
    // Settings store not available — fall through to hard default.
  }

  // ── Priority 3: hard fallback ──
  const result = {
    providerId: 'minimax-tts',
    voice: 'female-yujie',
    modelId: 'speech-2.8-hd',
    source: 'provider-default' as const,
  };
  console.info('[MOBILE PUBLISH][TTS Voice Resolve]', JSON.stringify({
    sceneId: sceneId ?? '(unknown)',
    source: result.source,
    providerId: result.providerId,
    voiceId: result.voice,
    modelId: result.modelId,
  }));
  return result;
}

/**
 * Call /api/generate/tts and return decoded ArrayBuffer + format.
 *
 * TTS voice is resolved from stage.teacherVoiceConfig (priority 1),
 * then settings store (priority 2), then hard fallback (priority 3).
 */
async function generateTTSForText(
  text: string,
  audioId: string,
  teacherVoiceConfig?: TeacherVoiceConfig | null,
  sceneId?: string,
): Promise<{
  data: ArrayBuffer;
  format: string;
}> {
  const ttsConfig = await resolveTtsConfigForPublish(teacherVoiceConfig, sceneId);

  const response = await fetch('/api/generate/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      audioId,
      ttsProviderId: ttsConfig.providerId,
      ttsModelId: ttsConfig.modelId,
      ttsVoice: ttsConfig.voice,
      ttsSpeed: 1.0,
      ttsApiKey: ttsConfig.apiKey || undefined,
      ttsBaseUrl: ttsConfig.baseUrl || undefined,
    }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => null);
    throw new Error(
      errBody?.message || errBody?.error || `TTS HTTP ${response.status}`,
    );
  }

  const json = await response.json();

  if (!json.success || !json.data?.base64) {
    throw new Error(json.message || json.error || 'TTS 返回数据缺失');
  }

  const binary = atob(json.data.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const format = json.data.format || 'mp3';

  return { data: bytes.buffer as ArrayBuffer, format };
}

/**
 * Extract narration text from a single speech action for TTS regeneration.
 *
 * Priority:
 *   1. speechAction.text (the original narration script)
 *   2. scene.narrationText
 *   3. scene.content (fallback)
 */
function extractNarrationTextForTTS(scene: Scene, speechAction: SpeechAction): string {
  if (speechAction.text && speechAction.text.trim()) {
    return speechAction.text.trim();
  }
  const narrationText = (scene as unknown as Record<string, unknown>).narrationText as
    | string
    | undefined;
  if (narrationText?.trim()) return narrationText.trim();
  const content = (scene as unknown as Record<string, unknown>).content as
    | string
    | undefined;
  if (content?.trim()) return content.trim();
  return '';
}

/**
 * Extract FULL chapter narration by joining ALL speech actions' text.
 * Used to generate a single combined audio per scene for mobile podcast mode.
 */
function extractFullNarrationText(scene: Scene): string {
  const actions = scene.actions ?? [];
  const speechActions = actions.filter((a) => isSpeechAction(a));
  const parts: string[] = [];
  for (const a of speechActions) {
    const sa = a as SpeechAction;
    if (sa.text?.trim()) parts.push(sa.text.trim());
  }
  return parts.join('\n\n').trim();
}

// ─── Simple stable hash ──────────────────────────────────────────
// djb2-style — deterministic, fast, no crypto dependency.
// Used to detect whether narration text or voice config changed,
// so we can skip re-generating unchanged chapter audio.
function stableHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

// ─── Interactive scene filter (mirrors lib/mobile/scene-helpers) ────

const INTERACTIVE_SCENE_KINDS = new Set(['quiz', 'interactive', 'pbl']);

function isInteractiveScene(scene: Scene): boolean {
  const kind = (scene as unknown as Record<string, unknown>).kind as string | undefined;
  if (kind && INTERACTIVE_SCENE_KINDS.has(kind)) return true;

  const interactionType = (scene as unknown as Record<string, unknown>)
    .interactionType as string | undefined;
  if (interactionType && INTERACTIVE_SCENE_KINDS.has(interactionType)) return true;

  const content = scene.content as unknown as Record<string, unknown> | undefined;
  if (content) {
    const contentStr = JSON.stringify(content).toLowerCase();
    for (const keyword of ['quiz', 'poll', 'exercise', 'interactive', 'choice']) {
      if (contentStr.includes(keyword)) return true;
    }
  }

  return false;
}

/**
 * Ensure speech actions have cloud-playable audioUrl before course publishing.
 *
 * Three-tier strategy per speech action:
 *
 *   1. audioUrl already exists → skip (fastest).
 *   2. No audioUrl but has audioId + IndexedDB blob → upload blob to cloud.
 *   3. No audioUrl, no blob → regenerate TTS from text → upload to cloud.
 *
 * audioId = browser-local IndexedDB cache key.
 * audioUrl = cloud URL required by shared/student playback.
 */
export async function publishSceneAudioAssets(
  stageId: string,
  scenes: Scene[],
  teacherVoiceConfig?: TeacherVoiceConfig | null,
): Promise<PublishSceneAudioAssetsResult> {
  console.info('[MOBILE PUBLISH][Audio Assets Start]', JSON.stringify({
    stageId,
    totalScenes: scenes.length,
    timestamp: new Date().toISOString(),
  }));

  const nextScenes = structuredClone(scenes) as Scene[];

  const uploaded: PublishedAudioItem[] = [];
  const skipped: PublishedAudioItem[] = [];
  const missing: MissingAudioItem[] = [];
  const failed: FailedAudioItem[] = [];
  const regenerated: RegeneratedAudioItem[] = [];

  for (const scene of nextScenes) {
    // Skip interactive scenes — they don't need audio for mobile podcast mode.
    if (isInteractiveScene(scene)) continue;

    const actions = scene.actions ?? [];

    for (const action of actions) {
      if (!isSpeechAction(action)) continue;

      const speechAction = action as SpeechAction & {
        audioId?: string;
        audioUrl?: string;
      };

      const sceneId = scene.id;
      const sceneOrder = scene.order;
      const actionId = speechAction.id;
      const audioId = speechAction.audioId;

      // ── Tier 1: Already has cloud URL ──
      if (speechAction.audioUrl) {
        skipped.push({
          sceneId,
          sceneOrder,
          actionId,
          audioId: audioId || '',
          audioUrl: speechAction.audioUrl,
        });
        continue;
      }

      // ── Tier 2: Has audioId → try IndexedDB blob ──
      if (audioId) {
        const record = await db.audioFiles.get(audioId);

        if (record?.blob) {
          try {
            const audioUrl = await uploadAudioRecordToCloud({
              stageId,
              audioId,
              record,
            });

            speechAction.audioUrl = audioUrl;

            console.info('[MOBILE PUBLISH][Audio Uploaded]', JSON.stringify({
              audioId,
              sceneId,
              source: 'indexeddb-blob',
              timestamp: new Date().toISOString(),
            }));

            uploaded.push({
              sceneId,
              sceneOrder,
              actionId,
              audioId,
              audioUrl,
            });
            continue;
          } catch (error) {
            log.warn(
              `Upload failed for ${audioId}:`,
              error instanceof Error ? error.message : String(error),
            );
            failed.push({
              sceneId,
              sceneOrder,
              actionId,
              audioId,
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
        }

        // audioId exists but no blob in IndexedDB — fall through to Tier 3
        console.info('[MOBILE PUBLISH][Audio Blob Missing Generate TTS]', JSON.stringify({
          audioId,
          sceneId,
          timestamp: new Date().toISOString(),
        }));
        log.info(
          `audioId ${audioId} has no IndexedDB blob, will regenerate TTS`,
        );
      }

      // ── Tier 3: No audioUrl, no blob → regenerate TTS ──
      const narrationText = extractNarrationTextForTTS(scene, speechAction);

      console.info('[TTS INPUT][Scene Audio]', JSON.stringify({
        sceneId,
        sceneTitle: scene.title || `(order ${sceneOrder})`,
        speechActionCount: (actions as unknown as SpeechAction[]).filter(isSpeechAction).length,
        firstSpeechTextLength: narrationText.length,
        fullTextLength: narrationText.length, // single-action = same as first
        fullTextPreview: narrationText.slice(0, 120),
        sourceField: `speechAction[${actionId}].text (individual)`,
      }));

      if (!narrationText) {
        missing.push({
          sceneId,
          sceneOrder,
          actionId,
          audioId: audioId || `(auto-${Date.now()})`,
          reason: '无法提取章节文字内容（speechAction.text / narrationText / content 均为空）',
        });
        continue;
      }

      const regenAudioId = audioId || `pub_${sceneId.slice(0, 8)}_${Date.now()}`;

      try {
        log.info(
          `Regenerating TTS for scene=${sceneId} action=${actionId} (${narrationText.length} chars)`,
        );

        const { data, format } = await generateTTSForText(
          narrationText,
          regenAudioId,
          teacherVoiceConfig,
          sceneId,
        );

        const audioUrl = await uploadBlobToCloud({
          stageId,
          audioId: regenAudioId,
          data,
          format,
        });

        speechAction.audioId = regenAudioId;
        speechAction.audioUrl = audioUrl;

        console.info('[TTS OUTPUT][Scene Audio]', JSON.stringify({
          sceneId,
          audioUrl: audioUrl.slice(0, 80),
          inputTextLength: narrationText.length,
          source: 'individual-speech-action',
          timestamp: new Date().toISOString(),
        }));

        console.info('[MOBILE PUBLISH][Audio Uploaded]', JSON.stringify({
          audioId: regenAudioId,
          sceneId,
          source: 'tts-regenerated',
          textLength: narrationText.length,
          timestamp: new Date().toISOString(),
        }));

        regenerated.push({
          sceneId,
          sceneOrder,
          actionId,
          audioId: regenAudioId,
          audioUrl,
          textLength: narrationText.length,
        });

        log.info(
          `TTS regenerated & uploaded: ${regenAudioId} → ${audioUrl.slice(0, 60)}...`,
        );
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : String(error);
        log.error(`TTS regeneration failed for ${regenAudioId}:`, errMsg);

        failed.push({
          sceneId,
          sceneOrder,
          actionId,
          audioId: regenAudioId,
          error: `TTS 重新生成失败: ${errMsg}`,
        });
      }
    }

    // ── Scene-level narration audio (best-effort, non-blocking) ──
    // The mobile player's PRIMARY playback path is audioSegments
    // (sequential speechAction.audioUrl playback). This narration
    // field is an OPTIONAL optimization for single-file chapters.
    //
    // Generation is best-effort only:
    //   - Short text (≤500 chars) → try direct TTS
    //   - Long text  (>500 chars) → SKIP (MiniMax can't handle it)
    //   - Failure          → console.warn, do NOT push to `failed`
    //   - Validation        → only checks speechAction.audioUrl
    const allSpeechActions = (actions as unknown as SpeechAction[]).filter(isSpeechAction);
    if (allSpeechActions.length > 0) {
      const fullText = extractFullNarrationText(scene);
      const sceneRaw = scene as unknown as Record<string, unknown>;

      // Only attempt narration TTS for short texts that fit in one API call.
      const NARRATION_MAX_CHARS = 500;
      if (fullText && fullText.length <= NARRATION_MAX_CHARS) {
        const textHash = stableHash(fullText + JSON.stringify(teacherVoiceConfig ?? {}));
        const narrationAudioId = `narration_${scene.id.slice(0, 8)}_${textHash.slice(0, 12)}`;
        const existingUrl = sceneRaw.narrationAudioUrl as string | undefined;
        const existingHash = sceneRaw.narrationAudioTextHash as string | undefined;
        const shouldRegenerate = !(existingUrl && existingHash === textHash);

        console.info('[TTS INPUT][Scene Narration Audio]', JSON.stringify({
          sceneId: scene.id,
          sceneTitle: scene.title || `(order ${scene.order})`,
          speechActionCount: allSpeechActions.length,
          fullTextLength: fullText.length,
          fullTextPreview: fullText.slice(0, 120),
          textHash,
          narrationAudioId,
          existingNarrationAudioUrl: existingUrl ?? '(none)',
          shouldRegenerate,
          sourceField: 'scene.actions[*].text joined (narration, short)',
        }));

        if (!shouldRegenerate) {
          console.info('[TTS SKIP][Scene Narration Audio]', JSON.stringify({
            sceneId: scene.id,
            narrationAudioId,
            textHash,
            reason: 'hash match — unchanged',
          }));
        } else {
          try {
            const { data: narrData, format: narrFormat } = await generateTTSForText(
              fullText,
              narrationAudioId,
              teacherVoiceConfig,
              scene.id,
            );

            const narrAudioUrl = await uploadBlobToCloud({
              stageId,
              audioId: narrationAudioId,
              data: narrData,
              format: narrFormat,
            });

            sceneRaw.narrationAudioUrl = narrAudioUrl;
            sceneRaw.narrationAudioId = narrationAudioId;
            sceneRaw.narrationAudioTextHash = textHash;

            console.info('[TTS OUTPUT][Scene Narration Audio]', JSON.stringify({
              sceneId: scene.id,
              narrationAudioUrl: narrAudioUrl.slice(0, 80),
              narrationAudioId,
              inputTextLength: fullText.length,
              textHash,
              timestamp: new Date().toISOString(),
            }));

            regenerated.push({
              sceneId: scene.id,
              sceneOrder: scene.order,
              actionId: '(narration)',
              audioId: narrationAudioId,
              audioUrl: narrAudioUrl,
              textLength: fullText.length,
            });

            log.info(
              `Narration TTS generated for scene=${scene.id} (${fullText.length} chars) → ${narrAudioUrl.slice(0, 60)}...`,
            );
          } catch (error) {
            // BEST-EFFORT: warn but NEVER block publish or push to failed[].
            // The mobile player will use audioSegments (speech action audios) instead.
            const errMsg = error instanceof Error ? error.message : String(error);
            log.warn(`Narration TTS best-effort failed for scene=${scene.id} (non-blocking): ${errMsg}`);
            console.warn('[TTS OUTPUT][Scene Narration Audio]', JSON.stringify({
              sceneId: scene.id,
              error: errMsg,
              source: 'narration-audio best-effort FAILED (non-blocking)',
              fallback: 'mobile player will use audioSegments (speech action audios)',
              timestamp: new Date().toISOString(),
            }));
          }
        }
      } else if (fullText) {
        // Text too long for single TTS call — skip narration generation.
        // Mobile player uses audioSegments path (sequential speech action playback).
        console.info('[TTS SKIP][Scene Narration Audio]', JSON.stringify({
          sceneId: scene.id,
          reason: `text too long (${fullText.length} chars > ${NARRATION_MAX_CHARS} limit), mobile player uses audioSegments`,
          speechActionCount: allSpeechActions.length,
          fallback: 'audioSegments (speechAction.audioUrl sequential playback)',
        }));
      }
    }
  }

  console.info('[MOBILE PUBLISH][Audio Assets Done]', JSON.stringify({
    stageId,
    skipped: skipped.length,
    uploaded: uploaded.length,
    regenerated: regenerated.length,
    missing: missing.length,
    failed: failed.length,
    timestamp: new Date().toISOString(),
  }));

  return {
    scenes: nextScenes,
    uploaded,
    skipped,
    missing,
    failed,
    regenerated,
  };
}

// ─── Validation ────────────────────────────────────────────────

export type AudioAssetValidationReason =
  | 'missing-speech-action'
  | 'missing-audio-url'
  | 'tts-generate-failed'
  | 'upload-failed';

export interface AudioAssetValidationIssue {
  sceneId: string;
  sceneTitle?: string;
  sceneOrder?: number;
  reason: AudioAssetValidationReason;
  detail?: string;
}

export interface AudioAssetValidationResult {
  ok: boolean;
  totalLearnableScenes: number;
  validScenes: number;
  issues: AudioAssetValidationIssue[];
}

/**
 * Validate that all non-interactive learnable scenes have published audio.
 *
 * Called after publishSceneAudioAssets() to verify the result before
 * saving to cloud. Also usable independently for pre-flight checks.
 */
export function validatePublishedAudioAssets(
  scenes: Scene[],
): AudioAssetValidationResult {
  const issues: AudioAssetValidationIssue[] = [];
  let totalLearnable = 0;
  let validCount = 0;

  for (const scene of scenes) {
    if (isInteractiveScene(scene)) continue;

    totalLearnable++;

    const sceneTitle =
      ((scene as unknown as Record<string, unknown>).name as string) ||
      ((scene as unknown as Record<string, unknown>).title as string) ||
      undefined;

    const actions = scene.actions ?? [];
    const speechActions = actions.filter((a) => isSpeechAction(a));

    if (speechActions.length === 0) {
      issues.push({
        sceneId: scene.id,
        sceneTitle,
        sceneOrder: scene.order,
        reason: 'missing-speech-action',
        detail: '该场景没有 speech 类型的 action',
      });
      continue;
    }

    const hasAudioUrl = speechActions.some(
      (a) => !!((a as SpeechAction & { audioUrl?: string }).audioUrl),
    );

    if (!hasAudioUrl) {
      issues.push({
        sceneId: scene.id,
        sceneTitle,
        sceneOrder: scene.order,
        reason: 'missing-audio-url',
        detail: `该场景的 ${speechActions.length} 个 speech action 均无 audioUrl`,
      });
      continue;
    }

    validCount++;
  }

  return {
    ok: issues.length === 0,
    totalLearnableScenes: totalLearnable,
    validScenes: validCount,
    issues,
  };
}
