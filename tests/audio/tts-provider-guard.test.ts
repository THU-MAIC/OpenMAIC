/**
 * Prototype-chain hardening for the TTS/ASR provider lookups.
 *
 * `TTS_PROVIDERS` / `ASR_PROVIDERS` are plain object literals, so an `in`
 * check (or a bare index) also matches inherited Object.prototype keys —
 * exactly the junk a persisted document or imported manifest can carry in its
 * open-string providerId. The guards must use own-property semantics.
 */
import { describe, expect, it } from 'vitest';

import {
  getASRProvider,
  getTTSProvider,
  isKnownTTSProviderId,
  TTS_PROVIDERS,
} from '@/lib/audio/constants';
import { findVoiceDisplayName } from '@/lib/audio/voice-resolver';
import type { ASRProviderId, TTSProviderId } from '@/lib/audio/types';

const PROTOTYPE_KEYS = ['toString', 'constructor', 'valueOf', 'hasOwnProperty'];

describe('isKnownTTSProviderId', () => {
  it('accepts every registered built-in provider and the custom namespace', () => {
    for (const id of Object.keys(TTS_PROVIDERS)) {
      expect(isKnownTTSProviderId(id)).toBe(true);
    }
    expect(isKnownTTSProviderId('custom-tts-mine')).toBe(true);
  });

  it('rejects unknown ids', () => {
    expect(isKnownTTSProviderId('definitely-not-a-tts-provider')).toBe(false);
    expect(isKnownTTSProviderId('')).toBe(false);
  });

  it('rejects prototype-chain keys', () => {
    for (const junk of PROTOTYPE_KEYS) {
      expect(isKnownTTSProviderId(junk)).toBe(false);
    }
  });
});

describe('getTTSProvider', () => {
  it('never resolves a prototype-chain key to an Object.prototype member', () => {
    for (const junk of PROTOTYPE_KEYS) {
      expect(getTTSProvider(junk as TTSProviderId)).toBeUndefined();
    }
  });
});

describe('getASRProvider', () => {
  it('never resolves a prototype-chain key to an Object.prototype member', () => {
    for (const junk of PROTOTYPE_KEYS) {
      expect(getASRProvider(junk as ASRProviderId)).toBeUndefined();
    }
  });
});

describe('findVoiceDisplayName', () => {
  it('falls back to the raw voice id for a prototype-chain provider key instead of crashing', () => {
    for (const junk of PROTOTYPE_KEYS) {
      expect(findVoiceDisplayName(junk as TTSProviderId, 'voice-1')).toBe('voice-1');
    }
  });
});
