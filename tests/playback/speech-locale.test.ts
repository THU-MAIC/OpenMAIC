import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackEngine } from '@/lib/playback/engine';
import i18n from '@/lib/i18n/config';
import { useSettingsStore } from '@/lib/store/settings';
import type { Scene } from '@/lib/types/stage';
import type { ActionEngine } from '@/lib/action/engine';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import { setModelSettingsViewForTests } from '../helpers/model-settings-view';

const initialLanguage = i18n.language;
afterEach(async () => {
  await i18n.changeLanguage(initialLanguage);
  setModelSettingsViewForTests(null);
  vi.unstubAllGlobals();
});

describe('browser narration locale', () => {
  it('reads the runtime language for each chunk and still prioritizes an explicit voice', async () => {
    const spoken: SpeechSynthesisUtterance[] = [];
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        lang = '';
        constructor(public text: string) {}
      },
    );
    vi.stubGlobal('window', {
      speechSynthesis: {
        getVoices: () => [{ voiceURI: 'english', lang: 'en-GB' }],
        cancel() {},
        speak: (utterance: SpeechSynthesisUtterance) => spoken.push(utterance),
      },
    });
    setModelSettingsViewForTests({ tts: { registryId: 'browser-native-tts' } });
    useSettingsStore.setState({ ttsVoice: 'default', ttsVoiceProviderId: 'browser-native-tts' });
    await i18n.changeLanguage('de-DE');
    const engine = new PlaybackEngine(
      [
        {
          id: 'scene',
          stageId: 'stage',
          type: 'slide',
          order: 1,
          actions: [
            { id: 'speech', type: 'speech', text: 'Guten Morgen. 你好，這是一段測試語音。' },
          ],
        } as Scene,
      ],
      {
        execute: vi.fn(async () => {}),
        clearEffects: vi.fn(),
        resetPlaybackVisualState: vi.fn(),
      } as unknown as ActionEngine,
      {
        play: vi.fn(async () => false),
        onEnded: vi.fn(),
        stop: vi.fn(),
        pause: vi.fn(),
      } as unknown as AudioPlayer,
      {},
    );
    engine.start();
    await vi.waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0].lang).toBe('de-DE');
    await i18n.changeLanguage('zh-TW');
    (spoken[0].onend as () => void)?.();
    await vi.waitFor(() => expect(spoken).toHaveLength(2));
    expect(spoken[1].lang).toBe('zh-TW');
    engine.stop();

    useSettingsStore.setState({ ttsVoice: 'english' });
    engine.start();
    await vi.waitFor(() => expect(spoken).toHaveLength(3));
    expect(spoken[2].lang).toBe('en-GB');
    engine.stop();
  });
});
