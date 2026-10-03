/**
 * Narration for one speech line: synthesized by POST /api/generate/tts with the
 * `tts` slot's provider and the teacher's voice, then stored in the asset pool.
 * The timeline editor's per-line regeneration calls it; a generation run
 * narrates its scenes on the server.
 */
import { db } from '@/lib/device-storage/database';
import { loadModelCapabilities } from '@/lib/model-settings/capabilities';
import { ttsSelection } from '@/lib/audio/tts-selection';
import { measureAudioDuration } from '@/lib/audio/audio-duration';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { resolveAgentVoiceOptions, pickNarratorAgent } from '@/lib/audio/agent-voice';
import {
  deterministicNarratorVoice,
  narratorBindingDiffers,
  narratorVoiceAfterMissingClone,
  resolveNarratorVoiceBinding,
  type ResolvedVoice,
} from '@/lib/audio/voice-resolver';
import { resolveTTSModelForVoice } from '@/lib/audio/constants';
import {
  isVoiceBindingUnavailable,
  markVoiceBindingNoticeShown,
  markVoiceBindingUnavailable,
  voiceBindingKey,
} from '@/lib/audio/unavailable-voice-bindings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { commitToPool } from '@/lib/media/commit-to-pool';
import { createLogger } from '@/lib/logger';
import { toast } from 'sonner';
import { getClientTranslation } from '@/lib/i18n';
import { withGenerationRetry, type GenerationRetryOptions } from '@openmaic/generation/browser';

const log = createLogger('NarrationTTS');

type ClientRetryOptions<T> = Partial<
  Omit<GenerationRetryOptions<T>, 'label' | 'shouldRetryResult' | 'signal'>
>;

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({
    error: response.statusText || 'Request failed',
  }));
}

function createHttpError(
  response: Response,
  data: { details?: unknown; error?: unknown; errorCode?: unknown },
  fallback: string,
): Error & { errorCode?: string; statusCode?: number } {
  const message =
    typeof data.details === 'string'
      ? data.details
      : typeof data.error === 'string'
        ? data.error
        : `${fallback}: HTTP ${response.status}`;
  const error = new Error(message) as Error & { errorCode?: string; statusCode?: number };
  if (typeof data.errorCode === 'string') {
    error.errorCode = data.errorCode;
  }
  error.statusCode = response.status;
  return error;
}

interface TTSApiResponse {
  success?: boolean;
  base64?: string;
  format?: string;
  error?: string;
  details?: string;
}

// A dead narrator voice is retried at most once against a DIFFERENT voice (the
// global voice when the binding differs from it, or the deterministic
// enabled-provider pick when bound == global). This bounds the total
// /api/generate/tts attempts to 2 per call and guarantees the
// QWEN_VC_VOICE_NOT_FOUND retry cannot loop a chain of dead voices
// (bound-dead → global-dead → deterministic-dead → …) forever.
const MAX_NARRATOR_VOICE_FALLBACK_HOPS = 1;

/** Generate TTS for one speech action and return its allocated asset reference. */
export async function generateAndStoreTTS(
  requestId: string,
  text: string,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
  stageId?: string,
  // Internal: an explicit voice that bypasses narrator binding resolution — used
  // to retry narration against the deterministic enabled-provider pick when the
  // pinned narrator voice (bound == global) turns out to be unusable.
  overrideVoice?: ResolvedVoice,
  // Internal: number of narrator voice-fallback hops already taken. Guards the
  // QWEN_VC_VOICE_NOT_FOUND retry so a chain of dead voices can never loop
  // /api/generate/tts beyond a single fallback hop.
  fallbackHops = 0,
): Promise<string | null> {
  // The `tts` slot's provider, and the user's voice for it.
  const selection = ttsSelection(await loadModelCapabilities());
  if (!selection) return null;
  const providersConfig = selection.providersConfig;
  // A generated roster's explicit voice binding is the course voice source of truth.
  // Global settings remain the fallback for classrooms without a binding.
  const teacher = pickNarratorAgent(useAgentRegistry.getState().listAgents());
  const boundVoice = teacher?.voiceConfig;
  const boundKey = boundVoice ? voiceBindingKey(boundVoice) : undefined;
  // The narrator pin makes boundVoice == the global voice. That equality must
  // not defeat the unavailable-binding fallbacks: when the pinned voice is
  // unusable (provider disabled, or the clone deleted server-side), fall back
  // to the deterministic enabled-provider pick with a single non-fatal notice
  // instead of throwing (QWEN_VC_VOICE_NOT_FOUND) or silently skipping.
  const globalVoice: ResolvedVoice = {
    providerId: selection.providerId,
    modelId: selection.modelId,
    voiceId: selection.voice,
  };
  const globalDiffers = narratorBindingDiffers(boundVoice, globalVoice);
  const fallbackForUnusablePin = (): ResolvedVoice | null => {
    if (!boundVoice) return null;
    const key = voiceBindingKey(boundVoice);
    markVoiceBindingUnavailable(boundVoice);
    if (markVoiceBindingNoticeShown(key)) {
      toast.warning(getClientTranslation('settings.qwenCloneNarrationUnavailable'));
    }
    return deterministicNarratorVoice(providersConfig);
  };

  let resolvedVoice =
    overrideVoice ??
    resolveNarratorVoiceBinding(
      boundVoice && isVoiceBindingUnavailable(boundVoice) ? undefined : boundVoice,
      globalVoice,
      providersConfig,
    );

  // Pinned narrator (bound == global) whose provider became disabled:
  // resolveNarratorVoiceBinding falls back to the global voice, which is the
  // same broken provider — swap in the deterministic enabled-provider pick
  // instead of silently skipping narration below.
  if (
    boundVoice &&
    !globalDiffers &&
    !isTTSProviderEnabled(resolvedVoice.providerId, providersConfig[resolvedVoice.providerId])
  ) {
    resolvedVoice = fallbackForUnusablePin() ?? resolvedVoice;
  }

  const ttsProviderId = resolvedVoice.providerId;
  const ttsVoice = resolvedVoice.voiceId;
  const ttsProviderConfig = providersConfig[ttsProviderId];
  const ttsModelId = resolveTTSModelForVoice(
    ttsProviderId,
    ttsVoice,
    resolvedVoice.modelId ?? ttsProviderConfig?.modelId,
  );

  if (ttsProviderId === 'browser-native-tts') return null;
  // Don't server-generate a voice of a provider the tts slot does not name (#665).
  if (!isTTSProviderEnabled(ttsProviderId, ttsProviderConfig)) return null;

  // Narration is the teacher's voice — resolve it from the teacher agent profile
  // through the single resolver (registers + references by id for stable timbre).
  const providerOptions = await resolveAgentVoiceOptions(teacher, {
    providerId: ttsProviderId,
    providerConfig: { ...ttsProviderConfig, modelId: ttsModelId },
    voiceId: ttsVoice,
    language,
  });
  let data: TTSApiResponse;
  try {
    data = await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The tts slot names the provider and model; the voice decides a
          // voice-clone model on the server.
          body: JSON.stringify({
            text,
            audioId: requestId,
            ttsVoice,
            ttsSpeed: selection.speed,
            ttsProviderOptions: providerOptions,
          }),
          signal,
        });

        const data = (await readJsonResponse(response)) as TTSApiResponse;
        if (!response.ok) {
          throw createHttpError(response, data, 'TTS request failed');
        }
        return data;
      },
      {
        label: `tts "${requestId}"`,
        shouldRetryResult: (result) => !result.success || !result.base64 || !result.format,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    const errorCode =
      error && typeof error === 'object' && 'errorCode' in error
        ? (error as { errorCode?: unknown }).errorCode
        : undefined;
    // Recover from a missing clone only when the attempt that just failed used
    // the bound binding itself: marking it unavailable makes the resolver fall
    // back to the global voice, a DIFFERENT voice. When the failure is already
    // on the global voice (or on the deterministic pick), retrying would hit
    // the same dead voice — fall through and surface the error instead of
    // hot-looping /api/generate/tts (bound-dead → global-dead → …). The
    // fallbackHops bound keeps even pathological chains at a single hop.
    if (
      errorCode === 'QWEN_VC_VOICE_NOT_FOUND' &&
      boundKey &&
      boundVoice &&
      fallbackHops < MAX_NARRATOR_VOICE_FALLBACK_HOPS
    ) {
      if (voiceBindingKey(resolvedVoice) === boundKey) {
        markVoiceBindingUnavailable(boundVoice);
        if (markVoiceBindingNoticeShown(boundKey)) {
          toast.warning(getClientTranslation('settings.qwenCloneNarrationUnavailable'));
        }
        // One retry with a different voice: the global one when the binding
        // differs from it (the resolver now skips the marked binding), else the
        // deterministic enabled-provider pick for a pinned narrator.
        const retryVoice = narratorVoiceAfterMissingClone({
          bound: boundVoice,
          globalVoice,
          failed: resolvedVoice,
          providerConfigs: providersConfig,
          usedFallbackVoice: !!overrideVoice,
        });
        if (retryVoice) {
          return generateAndStoreTTS(
            requestId,
            text,
            language,
            signal,
            retryOptions,
            stageId,
            globalDiffers ? undefined : retryVoice,
            fallbackHops + 1,
          );
        }
      }
    }
    throw error;
  }
  if (!data.success || !data.base64 || !data.format) {
    const err = new Error(
      data.details || data.error || 'TTS request failed: invalid response payload',
    );
    log.warn('TTS failed for', requestId, ':', err);
    throw err;
  }

  const binary = atob(data.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: `audio/${data.format}` });
  // Measure duration once at store time so video export (#854) can map this
  // clip onto a timeline without re-decoding. null → leave undefined; the audio
  // still persists and plays.
  const duration = measureAudioDuration(bytes, data.format) ?? undefined;
  /** This clip's local row, under whichever id it is currently known by. */
  const cachedNarrationRow = (id: string) => ({
    id,
    stageId,
    blob,
    duration,
    format: data.format as string,
    text,
    voice: ttsVoice,
    createdAt: Date.now(),
  });
  // The bytes go to the pool and the pool allocates the identity, so the id the speech action ends up holding names durable audio
  // rather than this browser's local table. Bytes land BEFORE the caller stamps
  // the action, so a document can never name narration that was not stored.
  const outcome = await commitToPool<void>({
    // The derived key, which is both what a refusal keeps the bytes under and
    // what narration adoption reads them back by on a later load.
    slot: requestId,
    bytes: blob,
    mimeType: blob.type,
    ...(duration === undefined ? {} : { meta: { durationSeconds: duration } }),
    // The bytes were just bought. A full store must not be what throws them
    // away: keeping them under the derived key is what lets the next load
    // re-attempt the upload from cache instead of paying the provider again,
    // which is the same contract a media Retry's retained bytes have. See the
    // caller's handling below for the other half of it -- the action has to
    // carry this key for adoption to find them.
    //
    // The rejection is NOT swallowed, and that is the point of awaiting it: a
    // stamp is only safe once the bytes are somewhere that can be read back. A
    // local table that refuses the row leaves nothing to adopt, so the commit
    // demotes itself to `failed` and the line goes unvoiced instead of carrying
    // a derived key that resolves to nothing for the rest of the course's life.
    retain: async () => {
      await db.audioFiles.put(cachedNarrationRow(requestId));
    },
    // Nothing to write back: the action this narration belongs to is not in the
    // document yet. The caller stamps it from the id returned here, which is
    // why this path has no funnel of its own to invent one.
    writeBack: async () => undefined,
    // A cache the pool already backs: a failed write costs a re-download, and
    // the primitive holds that to be best-effort for every caller.
    mirror: async (assetId) => {
      await db.audioFiles.put(cachedNarrationRow(assetId));
    },
  });

  if (outcome.status === 'stored') return outcome.assetId;
  if (outcome.status === 'refused-retained') {
    // The store had no room, and the bytes are kept. The action is stamped with
    // the derived key they are kept under, exactly as a refused image leaves
    // its placeholder in the slide: adoption reads that key on the next load,
    // re-attempts the upload, and writes the allocated id back with no provider
    // called. Returning null instead would leave the line unvoiced AND the
    // bytes unreachable, which is paying for the same clip on every attempt.
    log.warn(
      `Asset storage is full; keeping the narration for ${requestId} under its derived key.`,
    );
    return requestId;
  }
  // Storing narration failed for some other reason -- or the bytes could not be
  // kept -- and neither says anything about whether a later attempt would fit,
  // so nothing is left under a key a later load would take for adoptable
  // narration. A scene whose audio cannot be
  // stored keeps its text and leaves the line unvoiced and retryable, exactly
  // as an image that cannot be stored leaves its slide; reporting it as a TTS
  // failure would pause the whole deck at its first slide over one clip's
  // storage.
  log.warn('Narration storage failed; leaving the line unvoiced:', outcome.error);
  return null;
}

/**
 * Why a fresh clip never replaces the bytes behind an id it is superseding.
 *
 * Regeneration always forks to a fresh allocation. Replacing bytes behind a
 * live id requires proof that no other document holds it, and that proof is
 * unavailable by construction once references can leave this browser — asking
 * the pool who else holds an id would be exactly the existence oracle the
 * asset contract forbids.
 *
 * The superseded id is NOT removed either. Nothing at this point has observed
 * the new id reaching a durable document, so deleting the old bytes could leave
 * a still-referenced action pointing at nothing if the save that follows fails;
 * and the exclusivity that would make deletion safe is the same proof that is
 * unavailable. It does not have to be removed here: the save that writes the
 * new id is also the write that stops naming the old one, so the server stamps
 * the superseded entry as it lands and the collector releases it after the
 * grace period, the bytes following after their own. If that save never lands,
 * it is the NEW id that nothing committed, and it expires on
 * `ASSET_PENDING_TTL_MS` — either way regeneration leaves nothing permanent
 * behind.
 */
