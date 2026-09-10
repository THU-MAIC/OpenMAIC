'use client';

import { useCallback, useEffect, useState } from 'react';
import { db, type VoiceProfileRecord } from '@/lib/utils/database';
import type { TTSVoiceInfo } from '@/lib/audio/types';
import {
  VOXCPM_AUTO_VOICE,
  VOXCPM_AUTO_VOICE_ID,
  VOXCPM_TTS_PROVIDER_ID,
  buildAutoVoxCPMVoicePrompt,
  getVoxCPMProfileIdFromVoiceId,
  getVoxCPMProfileVoiceId,
  voxCPMBackendSupportsVoiceRegistration,
  type VoxCPMProviderOptions,
  type VoxCPMVoicePromptContext,
} from '@/lib/audio/voxcpm';
import {
  deleteRegisteredVoice,
  ensureRegisteredVoice,
  registerVoiceFromReference,
  type VoiceRegistrationRequestConfig,
} from '@/lib/audio/voice-registration-client';
import { InvalidReferenceAudioError, validateReferenceAudio } from '@/lib/audio/wav-validate';

export type VoxCPMVoiceProfile = VoiceProfileRecord;

const VOICE_PROFILES_CHANGED = 'voice-profiles-changed';
export const VOXCPM_REFERENCE_AUDIO_MAX_BYTES = 10 * 1024 * 1024;
export const VOXCPM_REFERENCE_AUDIO_MAX_SECONDS = 60;
export const QWEN_DECODER_PADDING_TOLERANCE_SECONDS = 0.5;

export function preserveRecordedVoiceName(currentName: string, defaultName: string): string {
  return currentName.trim() ? currentName : defaultName;
}

function notifyVoiceProfilesChanged(): void {
  window.dispatchEvent(new Event(VOICE_PROFILES_CHANGED));
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Failed to read reference audio'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function isWavAudio(blob: Blob, fileName?: string): boolean {
  return (
    blob.type.includes('audio/wav') ||
    blob.type.includes('audio/x-wav') ||
    /\.wav$/i.test(fileName || '')
  );
}

function replaceFileExtension(fileName: string | undefined, extension: string): string {
  const cleanName = fileName?.trim() || `reference.${extension}`;
  return cleanName.includes('.')
    ? cleanName.replace(/\.[^.]+$/u, `.${extension}`)
    : `${cleanName}.${extension}`;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

export function audioBufferToMonoWav(
  audioBuffer: AudioBuffer,
  sampleRate = audioBuffer.sampleRate,
): ArrayBuffer {
  // Tolerate only small decoder padding. Truncating a genuinely long upload
  // would silently pair a partial recording with the full transcript.
  if (
    audioBuffer.duration >
    VOXCPM_REFERENCE_AUDIO_MAX_SECONDS + QWEN_DECODER_PADDING_TOLERANCE_SECONDS
  ) {
    throw new InvalidReferenceAudioError();
  }
  const sampleCount = Math.min(Math.round(audioBuffer.duration * sampleRate), 60 * sampleRate);
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) =>
    audioBuffer.getChannelData(index),
  );
  let offset = 44;
  for (let i = 0; i < sampleCount; i++) {
    const sourcePosition = (i * audioBuffer.sampleRate) / sampleRate;
    const sourceIndex = Math.min(Math.floor(sourcePosition), audioBuffer.length - 1);
    const nextIndex = Math.min(sourceIndex + 1, audioBuffer.length - 1);
    const fraction = sourcePosition - sourceIndex;
    let mixed = 0;
    for (const channel of channels) {
      mixed += channel[sourceIndex] * (1 - fraction) + channel[nextIndex] * fraction;
    }
    const sample = Math.max(-1, Math.min(1, mixed / channels.length));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  if (typeof window === 'undefined') {
    throw new Error('Audio decoding requires a browser environment');
  }
  const AudioContextConstructor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error('This browser does not support audio conversion');
  }

  const audioContext = new AudioContextConstructor();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    return await audioContext.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await audioContext.close().catch(() => undefined);
  }
}

async function audioBlobToWav(blob: Blob): Promise<Blob> {
  const audioBuffer = await decodeAudioBlob(blob);
  return new Blob([audioBufferToMonoWav(audioBuffer)], { type: 'audio/wav' });
}

export async function normalizeQwenReferenceAudio(
  blob: Blob,
  fileName?: string,
): Promise<{ blob: Blob; name: string; mimeType: string }> {
  const audioBuffer = await decodeAudioBlob(blob);
  const wav = new Blob([audioBufferToMonoWav(audioBuffer, 24_000)], { type: 'audio/wav' });
  validateReferenceAudio(new Uint8Array(await wav.arrayBuffer()));
  return {
    blob: wav,
    name: replaceFileExtension(fileName, 'wav'),
    mimeType: 'audio/wav',
  };
}

export async function validateVoxCPMReferenceAudio(blob: Blob): Promise<void> {
  if (blob.size > VOXCPM_REFERENCE_AUDIO_MAX_BYTES) {
    throw new Error('Reference audio must be 10 MB or smaller');
  }

  const audioBuffer = await decodeAudioBlob(blob);
  if (audioBuffer.duration > VOXCPM_REFERENCE_AUDIO_MAX_SECONDS) {
    throw new Error('Reference audio must be 60 seconds or shorter');
  }
}

export async function normalizeVoxCPMReferenceAudio(
  blob: Blob,
  fileName?: string,
): Promise<{ blob: Blob; name: string; mimeType: string }> {
  await validateVoxCPMReferenceAudio(blob);

  if (isWavAudio(blob, fileName)) {
    return {
      blob,
      name: replaceFileExtension(fileName, 'wav'),
      mimeType: blob.type || 'audio/wav',
    };
  }

  const wavBlob = await audioBlobToWav(blob);
  if (wavBlob.size > VOXCPM_REFERENCE_AUDIO_MAX_BYTES) {
    throw new Error('Reference audio must be 10 MB or smaller after conversion');
  }
  return {
    blob: wavBlob,
    name: replaceFileExtension(fileName, 'wav'),
    mimeType: 'audio/wav',
  };
}

export function getVoxCPMVoiceOptions(
  profiles: VoxCPMVoiceProfile[],
  options: { supportsClone?: boolean } = {},
): TTSVoiceInfo[] {
  const visibleProfiles = options.supportsClone
    ? profiles
    : profiles.filter((profile) => profile.kind !== 'clone');
  return [
    VOXCPM_AUTO_VOICE,
    ...visibleProfiles.map((profile) => ({
      id: getVoxCPMProfileVoiceId(profile.id),
      name: profile.name,
      language: 'auto',
      gender: 'neutral' as const,
      description:
        profile.kind === 'clone' ? 'Browser-saved cloned voice' : 'Browser-saved prompt voice',
    })),
  ];
}

export function useVoxCPMVoiceProfiles() {
  const [profiles, setProfiles] = useState<VoxCPMVoiceProfile[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await db.voiceProfiles
        .where('providerId')
        .equals(VOXCPM_TTS_PROVIDER_ID)
        .toArray();
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      setProfiles(rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener(VOICE_PROFILES_CHANGED, refresh);
    return () => window.removeEventListener(VOICE_PROFILES_CHANGED, refresh);
  }, [refresh]);

  const addPromptVoice = useCallback(
    async (input: { name: string; voicePrompt: string }) => {
      const now = Date.now();
      const id = createId();
      await db.voiceProfiles.put({
        id,
        providerId: VOXCPM_TTS_PROVIDER_ID,
        kind: 'prompt',
        name: input.name.trim(),
        voicePrompt: input.voicePrompt.trim(),
        createdAt: now,
        updatedAt: now,
      });
      await refresh();
      notifyVoiceProfilesChanged();
      return getVoxCPMProfileVoiceId(id);
    },
    [refresh],
  );

  const addCloneVoice = useCallback(
    async (input: {
      name: string;
      referenceAudio: Blob;
      referenceAudioName?: string;
      referenceAudioMimeType?: string;
      promptText?: string;
      voicePrompt?: string;
    }) => {
      const now = Date.now();
      const id = createId();
      const referenceAudio = await normalizeVoxCPMReferenceAudio(
        input.referenceAudio,
        input.referenceAudioName,
      );
      await db.voiceProfiles.put({
        id,
        providerId: VOXCPM_TTS_PROVIDER_ID,
        kind: 'clone',
        name: input.name.trim(),
        voicePrompt: input.voicePrompt?.trim() || undefined,
        promptText: input.promptText?.trim() || undefined,
        referenceAudio: referenceAudio.blob,
        referenceAudioName: referenceAudio.name,
        referenceAudioMimeType: referenceAudio.mimeType,
        createdAt: now,
        updatedAt: now,
      });
      await refresh();
      notifyVoiceProfilesChanged();
      return getVoxCPMProfileVoiceId(id);
    },
    [refresh],
  );

  const deleteVoice = useCallback(
    async (id: string) => {
      await db.voiceProfiles.delete(id);
      await refresh();
      notifyVoiceProfilesChanged();
    },
    [refresh],
  );

  return { profiles, loading, refresh, addPromptVoice, addCloneVoice, deleteVoice };
}

export function useAllVoiceProfiles() {
  const [profiles, setProfiles] = useState<VoiceProfileRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await db.voiceProfiles.toArray();
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      setProfiles(rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener(VOICE_PROFILES_CHANGED, refresh);
    return () => window.removeEventListener(VOICE_PROFILES_CHANGED, refresh);
  }, [refresh]);

  return { profiles, loading, refresh };
}

export function useQwenVoiceProfiles() {
  const [profiles, setProfiles] = useState<VoiceProfileRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await db.voiceProfiles.where('providerId').equals('qwen-tts').toArray();
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      setProfiles(rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener(VOICE_PROFILES_CHANGED, refresh);
    return () => window.removeEventListener(VOICE_PROFILES_CHANGED, refresh);
  }, [refresh]);

  const addCloneVoice = useCallback(
    async (
      input: { name: string; referenceAudio: File; refText: string },
      request: VoiceRegistrationRequestConfig,
    ) => {
      const normalized = await normalizeQwenReferenceAudio(
        input.referenceAudio,
        input.referenceAudio.name,
      );
      const referenceAudio = new File([normalized.blob], normalized.name, {
        type: normalized.mimeType,
      });
      const voiceId = await registerVoiceFromReference(
        'qwen-tts',
        {
          name: input.name,
          referenceAudio,
          refText: input.refText,
        },
        request,
      );
      const now = Date.now();
      await db.voiceProfiles.put({
        id: voiceId,
        providerId: 'qwen-tts',
        kind: 'clone',
        name: input.name.trim(),
        promptText: input.refText,
        referenceAudio,
        referenceAudioName: referenceAudio.name,
        referenceAudioMimeType: referenceAudio.type,
        createdAt: now,
        updatedAt: now,
      });
      await refresh();
      notifyVoiceProfilesChanged();
      return voiceId;
    },
    [refresh],
  );

  const deleteVoice = useCallback(
    async (id: string, request: VoiceRegistrationRequestConfig) => {
      const vendorDeleted = await deleteRegisteredVoice('qwen-tts', id, request);
      if (!vendorDeleted) {
        console.warn('[QwenVoiceProfiles] Provider deletion failed; removing local profile');
      }
      await db.voiceProfiles.delete(id);
      await refresh();
      notifyVoiceProfilesChanged();
      return vendorDeleted;
    },
    [refresh],
  );

  return { profiles, loading, refresh, addCloneVoice, deleteVoice };
}

export async function getVoxCPMProviderOptions(
  voiceId: string,
  context?: VoxCPMVoicePromptContext,
  request?: VoiceRegistrationRequestConfig,
): Promise<VoxCPMProviderOptions> {
  if (voiceId === VOXCPM_AUTO_VOICE_ID) {
    // Drive register-once only when this VoxCPM backend supports it; otherwise
    // (and on any failure) fall back to the inline voice-design prompt.
    const canRegister =
      !!request &&
      !!context?.voiceDesign &&
      voxCPMBackendSupportsVoiceRegistration(context.backend ?? 'vllm-omni');
    const registeredVoiceId = canRegister
      ? await ensureRegisteredVoice(
          VOXCPM_TTS_PROVIDER_ID,
          { voiceDesign: context!.voiceDesign, language: context!.language || context!.locale },
          request!,
        ).catch(() => undefined)
      : undefined;
    return {
      voiceMode: 'auto',
      voicePrompt: buildAutoVoxCPMVoicePrompt(context), // inline fallback always set
      ...(registeredVoiceId ? { registeredVoiceId } : {}),
    };
  }

  const profileId = getVoxCPMProfileIdFromVoiceId(voiceId);
  if (!profileId) {
    return {
      voiceMode: 'prompt',
      voicePrompt: voiceId,
    };
  }

  const profile = await db.voiceProfiles.get(profileId);
  if (!profile) {
    return {
      voiceMode: 'auto',
      voicePrompt: buildAutoVoxCPMVoicePrompt(context),
    };
  }

  if (profile.kind === 'clone' && profile.referenceAudio) {
    return {
      voiceMode: 'clone',
      voicePrompt: profile.voicePrompt,
      promptText: profile.promptText,
      referenceAudioBase64: await blobToBase64(profile.referenceAudio),
      referenceAudioMimeType:
        profile.referenceAudioMimeType || profile.referenceAudio.type || 'audio/wav',
      referenceAudioName: profile.referenceAudioName || `${profile.name}.wav`,
    };
  }

  return {
    voiceMode: 'prompt',
    voicePrompt: profile.voicePrompt || profile.name,
  };
}
