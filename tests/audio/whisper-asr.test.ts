import { describe, expect, it, vi, beforeEach } from 'vitest';
import { normalizeWhisperLanguage, transcribeAudio } from '@/lib/audio/asr-providers';

const mockTranscribe = vi.fn();
const mockOpenAITranscription = vi.fn();
const mockCreateOpenAI = vi.fn();

vi.mock('ai', () => ({
  experimental_transcribe: (...args: unknown[]) => mockTranscribe(...args),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (...args: unknown[]) => {
    mockCreateOpenAI(...args);
    return {
      transcription: (...tArgs: unknown[]) => mockOpenAITranscription(...tArgs),
    };
  },
}));

function dummyAudioBuffer(): Buffer {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
}

describe('OpenAI Whisper language normalization (#1082)', () => {
  describe('normalizeWhisperLanguage', () => {
    it('returns undefined when language is undefined, null, or empty', () => {
      expect(normalizeWhisperLanguage(undefined)).toBeUndefined();
      expect(normalizeWhisperLanguage('')).toBeUndefined();
      expect(normalizeWhisperLanguage('   ')).toBeUndefined();
    });

    it('maps "auto" (case-insensitive) to undefined for auto-detection', () => {
      expect(normalizeWhisperLanguage('auto')).toBeUndefined();
      expect(normalizeWhisperLanguage('AUTO')).toBeUndefined();
      expect(normalizeWhisperLanguage(' Auto ')).toBeUndefined();
    });

    it('preserves clean ISO-639-1 two-letter codes', () => {
      expect(normalizeWhisperLanguage('en')).toBe('en');
      expect(normalizeWhisperLanguage('zh')).toBe('zh');
      expect(normalizeWhisperLanguage('pt')).toBe('pt');
      expect(normalizeWhisperLanguage('ja')).toBe('ja');
      expect(normalizeWhisperLanguage('ko')).toBe('ko');
      expect(normalizeWhisperLanguage('es')).toBe('es');
      expect(normalizeWhisperLanguage('de')).toBe('de');
      expect(normalizeWhisperLanguage('fr')).toBe('fr');
    });

    it('strips region subtags to base language code', () => {
      expect(normalizeWhisperLanguage('pt-BR')).toBe('pt');
      expect(normalizeWhisperLanguage('pt-PT')).toBe('pt');
      expect(normalizeWhisperLanguage('zh-CN')).toBe('zh');
      expect(normalizeWhisperLanguage('zh-TW')).toBe('zh');
      expect(normalizeWhisperLanguage('en-US')).toBe('en');
      expect(normalizeWhisperLanguage('en-GB')).toBe('en');
      expect(normalizeWhisperLanguage('es-ES')).toBe('es');
      expect(normalizeWhisperLanguage('es-MX')).toBe('es');
      expect(normalizeWhisperLanguage('de-DE')).toBe('de');
      expect(normalizeWhisperLanguage('fr-FR')).toBe('fr');
      expect(normalizeWhisperLanguage('ja-JP')).toBe('ja');
      expect(normalizeWhisperLanguage('ko-KR')).toBe('ko');
    });

    it('handles underscore-separated tags and mixed case', () => {
      expect(normalizeWhisperLanguage('pt_BR')).toBe('pt');
      expect(normalizeWhisperLanguage('ZH_CN')).toBe('zh');
      expect(normalizeWhisperLanguage('EN-us')).toBe('en');
      expect(normalizeWhisperLanguage(' zh-Hans-CN ')).toBe('zh');
    });

    it('maps Cantonese (yue / yue-Hant-HK) to Chinese (zh)', () => {
      expect(normalizeWhisperLanguage('yue')).toBe('zh');
      expect(normalizeWhisperLanguage('yue-Hant-HK')).toBe('zh');
      expect(normalizeWhisperLanguage('YUE-HK')).toBe('zh');
    });
  });

  describe('transcribeAudio with openai-whisper', () => {
    beforeEach(() => {
      mockTranscribe.mockReset();
      mockOpenAITranscription.mockReset();
      mockCreateOpenAI.mockReset();

      mockOpenAITranscription.mockReturnValue('mock-model-instance');
      mockTranscribe.mockResolvedValue({ text: 'transcribed speech' });
    });

    it('passes stripped base language to providerOptions.openai.language when given a region subtag', async () => {
      const result = await transcribeAudio(
        {
          providerId: 'openai-whisper',
          apiKey: 'sk-test',
          language: 'pt-BR',
        },
        dummyAudioBuffer(),
      );

      expect(mockTranscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: {
            openai: {
              language: 'pt',
            },
          },
        }),
      );
      expect(result).toEqual({ text: 'transcribed speech' });
    });

    it('passes undefined for "auto" language', async () => {
      await transcribeAudio(
        {
          providerId: 'openai-whisper',
          apiKey: 'sk-test',
          language: 'auto',
        },
        dummyAudioBuffer(),
      );

      expect(mockTranscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: {
            openai: {
              language: undefined,
            },
          },
        }),
      );
    });

    it('passes standard ISO-639-1 language code unchanged', async () => {
      await transcribeAudio(
        {
          providerId: 'openai-whisper',
          apiKey: 'sk-test',
          language: 'zh',
        },
        dummyAudioBuffer(),
      );

      expect(mockTranscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: {
            openai: {
              language: 'zh',
            },
          },
        }),
      );
    });
  });
});
