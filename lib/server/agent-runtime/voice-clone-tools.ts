/**
 * Voice-cloning agent tools: `clip_audio` and `register_voice`.
 *
 * `clip_audio` cuts a clean single-speaker monologue out of an audio or video
 * session material and persists it back as a session material (`audio-track`,
 * 24 kHz mono PCM WAV) so `register_voice` can reference it by id. The clip
 * bytes live in the session's material asset partition — the same hash
 * addressed store the material tools read and write through, scoped by
 * `session-materials:<sessionId>`, so a foreign or stale id never resolves to
 * another session's bytes.
 *
 * `register_voice` dispatches through the provider-neutral
 * `VoiceRegistrationAdapter` seam (`getVoiceRegistrationAdapter(providerId)`),
 * never through a vendor client: the provider comes from server config, the
 * adapter registry owns the vendor knowledge, and the tool only ever sees
 * `supportsRegistration` / `registerVoice`. It is registered as a runner tool
 * ONLY when at least one served provider's adapter reports
 * `supportsRegistration` with a configured key — a model must never see a tool
 * that can only throw "deployment has no voice registration backend
 * configured". The internal guard stays as defense in depth for direct calls.
 *
 * Voice cloning is an in-session loop by design: `register_voice` appends the
 * successful clone to a shared session-scoped registry that `list_voices` and
 * `set_roster` read, so the model can bind the exact pair it registered in the
 * same session. No persistence, no per-owner quota, no billing.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  createMaterialId,
  type AgentSessionMaterial,
  type CreateAgentSessionMaterialInput,
} from '@openmaic/storage';
import { Type } from 'typebox';

import type { RegisteredVoiceInfo } from '@/lib/audio/voice-catalog';
import {
  getVoiceRegistrationAdapter,
  type VoiceRegistrationConfig,
} from '@/lib/audio/voice-registration';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { validateReferenceAudio } from '@/lib/audio/wav-validate';
import {
  enabledServerTTSProviderIds,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';
import {
  getAgentSessionMaterialStore,
  getSessionMaterial,
  removeSessionMaterialRawAsset,
  resolveSessionMaterialRawAsset,
  storeSessionMaterialRawAsset,
} from './session-materials';

const execFileAsync = promisify(execFile);
const MIN_CLIP_SECONDS = 1;
const MAX_CLIP_SECONDS = 60;
const OUTPUT_SAMPLE_RATE = 24_000;
const OUTPUT_CHANNELS = 1;
const CLIP_MIME = 'audio/wav';

const CLIP_AUDIO_SCHEMA = Type.Object({
  materialId: Type.String({
    description: 'The audio or video material id returned by list_materials.',
  }),
  startSec: Type.Number({
    minimum: 0,
    description: 'Inclusive start time in seconds.',
  }),
  endSec: Type.Number({
    minimum: 0,
    description: 'Exclusive end time in seconds.',
  }),
});

const REGISTER_VOICE_SCHEMA = Type.Object({
  name: Type.String({
    minLength: 1,
    maxLength: 200,
    description: 'Human-readable name for the cloned voice, such as the speaker name.',
  }),
  clipId: Type.String({
    description: 'The clipId returned by clip_audio.',
  }),
  refText: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description: 'Accurate verbatim transcript of the reference clip.',
  }),
});

export interface VoiceCloneToolDependencies {
  sessionId: string;
  /** Test seam; defaults to the session-scoped material read (foreign ids read as absent). */
  getMaterial?: (sessionId: string, materialId: string) => Promise<AgentSessionMaterial | null>;
  /** Test seam; defaults to the asset-registry raw-byte read scoped to the session. */
  readRawAsset?: (
    sessionId: string,
    rawAssetId: string,
  ) => Promise<{ bytes: Buffer; mime: string } | null>;
  /** Test seam; defaults to writing the bytes into the session's material asset partition. */
  storeRawAsset?: (sessionId: string, bytes: Buffer, mime: string) => Promise<string>;
  /** Test seam; defaults to removing a just-stored asset (write compensation). */
  removeRawAsset?: (sessionId: string, rawAssetId: string) => Promise<void>;
  /** Test seam; defaults to the session-scoped material store create. */
  createMaterial?: (
    sessionId: string,
    input: CreateAgentSessionMaterialInput,
  ) => Promise<AgentSessionMaterial>;
  /** Test seam; defaults to the ffmpeg clip. */
  clipAudio?: (
    source: Buffer,
    sourceName: string,
    startSec: number,
    endSec: number,
  ) => Promise<Buffer>;
  /**
   * Session-scoped registry of voices registered by `register_voice` (not
   * persisted — voice cloning is an in-session loop). The runner threads ONE
   * array into both this builder and buildRosterTools, so list_voices /
   * set_roster can see the cloned voice in the same session.
   */
  registeredVoices?: RegisteredVoiceInfo[];
}

/**
 * The served providers whose registration adapters are actually usable:
 * adapter present, `supportsRegistration` true for this deployment, and the
 * provider's API key configured when it requires one. `register_voice` is only
 * offered as a runner tool when this list is non-empty.
 */
export function registrationCapableProviderIds(): string[] {
  return enabledServerTTSProviderIds().filter((id) => {
    const adapter = getVoiceRegistrationAdapter(id);
    if (!adapter || !adapter.supportsRegistration()) return false;
    const config = TTS_PROVIDERS[id as keyof typeof TTS_PROVIDERS];
    if (config?.requiresApiKey && !resolveTTSApiKey(id)) return false;
    return true;
  });
}

/** Whether this deployment has a working voice-registration backend. */
export function hasConfiguredVoiceRegistrationCapability(): boolean {
  return registrationCapableProviderIds().length > 0;
}

/** The configured registration provider the tool registers on (first wins). */
function resolveRegistrationProviderId(): string | undefined {
  return registrationCapableProviderIds()[0];
}

function sourceExtension(record: AgentSessionMaterial): string {
  const fromName = extname(record.title ?? '');
  if (fromName && fromName.length <= 10) return fromName;
  return '';
}

/** Best-effort source file extension from the recorded media type. */
function extensionForMime(mime: string): string {
  const extensions: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/webm': '.webm',
  };
  return extensions[mime.toLowerCase()] ?? '.media';
}

export function validateClipRange(startSec: number, endSec: number): number {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0) {
    throw new Error('clip_audio requires finite, non-negative startSec and endSec values');
  }
  const durationSeconds = endSec - startSec;
  if (durationSeconds < MIN_CLIP_SECONDS || durationSeconds > MAX_CLIP_SECONDS) {
    throw new Error(
      `clip_audio duration must be between ${MIN_CLIP_SECONDS} and ${MAX_CLIP_SECONDS} seconds`,
    );
  }
  return durationSeconds;
}

/** Run ffmpeg without translating its failure, so callers retain the original stderr and exit data. */
export async function clipAudioToVoiceWav(
  source: Buffer,
  sourceName: string,
  startSec: number,
  endSec: number,
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'voice-clip-'));
  const inputPath = join(directory, `source${extname(sourceName) || '.media'}`);
  const outputPath = join(directory, 'clip.wav');
  try {
    await writeFile(inputPath, source);
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(startSec),
      '-i',
      inputPath,
      '-t',
      String(endSec - startSec),
      '-vn',
      '-acodec',
      'pcm_s16le',
      '-ar',
      String(OUTPUT_SAMPLE_RATE),
      '-ac',
      String(OUTPUT_CHANNELS),
      '-y',
      outputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function isAudioOrVideo(mime: string): boolean {
  return mime.startsWith('audio/') === true || mime.startsWith('video/') === true;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('aborted');
}

/** Build the owner- and session-scoped voice-cloning tools for the agent. */
export function buildVoiceCloneTools(deps: VoiceCloneToolDependencies): AgentTool<never, never>[] {
  const getMaterial = deps.getMaterial ?? getSessionMaterial;
  const readRawAsset = deps.readRawAsset ?? resolveSessionMaterialRawAsset;
  const storeRawAsset = deps.storeRawAsset ?? storeSessionMaterialRawAsset;
  const removeRawAsset = deps.removeRawAsset ?? removeSessionMaterialRawAsset;
  const createMaterial =
    deps.createMaterial ??
    (async (sessionId, input) => {
      const store = await getAgentSessionMaterialStore();
      return store.createMaterial(sessionId, input);
    });
  const clipAudio = deps.clipAudio ?? clipAudioToVoiceWav;
  // Session-scoped registered voices: appended on successful register_voice so
  // list_voices / set_roster (roster-tools) can enumerate and validate them.
  const registeredVoices = deps.registeredVoices;
  const recordRegisteredVoice = (voice: RegisteredVoiceInfo): void => {
    if (!registeredVoices) return;
    const binding = `${voice.providerId}::${voice.voiceId}`;
    if (
      !registeredVoices.some(
        (existing) => `${existing.providerId}::${existing.voiceId}` === binding,
      )
    ) {
      registeredVoices.push(voice);
    }
  };
  // Keep retries within one run idempotent: the same clip + name + transcript
  // resolves to the same provider voice and is registered once.
  const registrationCache = new Map<string, Promise<string>>();

  const clipAudioTool: AgentTool<typeof CLIP_AUDIO_SCHEMA> = {
    name: 'clip_audio',
    label: 'Clip reference audio',
    description:
      'Clip a clean single-speaker monologue from an audio or video material for voice cloning. ' +
      'Read the material transcript first and choose the interval yourself. Prefer 10–20 seconds ' +
      'with no background music, other speakers, or noise. Returns a 24 kHz mono PCM WAV clip.',
    parameters: CLIP_AUDIO_SCHEMA,
    execute: async (_callId, params, signal) => {
      validateClipRange(params.startSec, params.endSec);
      throwIfAborted(signal);
      const source = await getMaterial(deps.sessionId, params.materialId);
      throwIfAborted(signal);
      if (!source) {
        throw new Error('material does not exist or does not belong to this session owner');
      }
      if (!source.rawAssetId) {
        throw new Error('clip_audio requires an audio or video material');
      }
      const raw = await readRawAsset(deps.sessionId, source.rawAssetId);
      throwIfAborted(signal);
      if (!raw) throw new Error('material bytes are unavailable');
      if (!isAudioOrVideo(raw.mime)) {
        throw new Error('clip_audio requires an audio or video material');
      }

      const sourceName = `${source.id}${sourceExtension(source) || extensionForMime(raw.mime)}`;
      const wav = await clipAudio(raw.bytes, sourceName, params.startSec, params.endSec);
      // Enforces the exact 24 kHz mono PCM WAV contract and the 1–60 s bounds.
      const validated = validateReferenceAudio(wav);
      throwIfAborted(signal);

      const clipId = createMaterialId();
      const rawAssetId = await storeRawAsset(deps.sessionId, wav, CLIP_MIME);
      try {
        await createMaterial(deps.sessionId, {
          id: clipId,
          kind: 'audio-track',
          title: `${source.title ?? source.id} clip`,
          rawAssetId,
        });
      } catch (error) {
        await removeRawAsset(deps.sessionId, rawAssetId).catch(() => undefined);
        throw error;
      }
      const result = {
        clipId,
        rawAssetId,
        durationSeconds: validated.durationSeconds,
        mime: CLIP_MIME,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };

  const registerVoiceTool: AgentTool<typeof REGISTER_VOICE_SCHEMA> = {
    name: 'register_voice',
    label: 'Register cloned voice',
    description:
      'Register a reference audio clip as a named cloned voice on this deployment. Returns the ' +
      'provider and voice id that can be bound to a teacher with set_roster.',
    parameters: REGISTER_VOICE_SCHEMA,
    execute: async (_callId, params, signal) => {
      const providerId = resolveRegistrationProviderId();
      const adapter = providerId ? getVoiceRegistrationAdapter(providerId) : undefined;
      if (!providerId || !adapter || !adapter.supportsRegistration()) {
        throw new Error('deployment has no voice registration backend configured');
      }
      throwIfAborted(signal);
      const clip = await getMaterial(deps.sessionId, params.clipId);
      throwIfAborted(signal);
      if (!clip) {
        throw new Error('clip does not exist or does not belong to this session owner');
      }
      if (clip.kind !== 'audio-track' || !clip.rawAssetId) {
        throw new Error('clipId is not a voice-cloning reference clip');
      }
      const raw = await readRawAsset(deps.sessionId, clip.rawAssetId);
      throwIfAborted(signal);
      if (!raw) throw new Error('voice-cloning reference clip is unavailable or corrupt');
      if (!isAudioOrVideo(raw.mime)) {
        throw new Error('voice-cloning reference must be a 24 kHz mono PCM WAV clip');
      }
      // Enforces the 24 kHz mono PCM WAV contract (the clip_audio output shape).
      validateReferenceAudio(raw.bytes);
      throwIfAborted(signal);

      const cfg: VoiceRegistrationConfig = {
        baseUrl: resolveTTSBaseUrl(providerId) ?? '',
        apiKey: resolveTTSApiKey(providerId),
        model: adapter.resolveRegistrationModel(),
      };
      const registrationKey = createHash('sha256')
        .update(clip.rawAssetId)
        .update('\0')
        .update(params.name.trim())
        .update('\0')
        .update(params.refText.trim())
        .digest('hex');
      let pending = registrationCache.get(registrationKey);
      if (!pending) {
        pending = adapter.registerVoice(
          cfg,
          {
            voiceId: params.name.trim(),
            referenceAudioBase64: raw.bytes.toString('base64'),
            mimeType: CLIP_MIME,
            refText: params.refText,
          },
          signal,
        );
        registrationCache.set(registrationKey, pending);
      }
      let voiceId: string;
      try {
        voiceId = await pending;
      } catch (error) {
        // A failed enrollment must not poison the cache: a retry re-registers.
        registrationCache.delete(registrationKey);
        throw error;
      }
      const result = {
        providerId,
        voiceId,
        name: params.name.trim(),
      };
      // Make the clone visible to list_voices / set_roster in this session
      // (voice cloning is an in-session loop; the roster keeps the durable
      // record).
      recordRegisteredVoice({
        providerId,
        voiceId,
        name: result.name,
        kind: 'clone',
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };

  // register_voice is only offered when the deployment has a registration
  // backend; otherwise the agent would see a tool that can only throw
  // "deployment has no voice registration backend configured". The internal
  // guard above stays as defense in depth for direct calls.
  const tools: AgentTool<never, never>[] = [clipAudioTool] as unknown as AgentTool<never, never>[];
  if (hasConfiguredVoiceRegistrationCapability()) {
    tools.push(registerVoiceTool as unknown as AgentTool<never, never>);
  }
  return tools;
}

export const VOICE_CLONE_TOOL_NAMES = ['clip_audio', 'register_voice'] as const;

/** Voice-cloning guidance layered into every runner prompt. */
export function voiceCloneToolsPrompt(registrationEnabled: boolean): string {
  return [
    'To clone a voice, clip_audio a clean 10–20 second single-speaker monologue from an audio or video material (read its transcript first and choose the interval yourself); it returns a 24 kHz mono PCM WAV clip stored as a session material.',
    ...(registrationEnabled
      ? [
          'After clipping, register_voice the returned clipId with an accurate verbatim transcript. The returned `providerId::voiceId` pair can be bound with set_roster.',
        ]
      : [
          'This deployment has no voice registration backend, so cloned voices cannot be registered; do not attempt register_voice.',
        ]),
  ].join(' ');
}
