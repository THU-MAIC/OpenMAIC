import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US', setLocale: () => {} }),
}));

import { TTSSpeedField } from '@/components/settings/tts-speed-field';
import { TTS_PROVIDERS } from '@/lib/audio/constants';

function renderField(props: Partial<ComponentProps<typeof TTSSpeedField>> = {}) {
  return renderToStaticMarkup(
    createElement(TTSSpeedField, { speed: 1.5, onSpeedChange: () => undefined, ...props }),
  );
}

function sliderTag(html: string): string {
  return html.match(/<input[^>]*type="range"[^>]*>/)?.[0] ?? '';
}

describe('TTSSpeedField', () => {
  it('locks the slider at 1× for a provider declaring supportsSpeed: false', () => {
    const html = renderField({ provider: { supportsSpeed: false } });

    expect(sliderTag(html)).toContain('disabled=""');
    expect(sliderTag(html)).toContain('value="1"');
    expect(html).toContain('1×');
    expect(html).toContain('settings.ttsSpeedUnsupported');
  });

  it('keeps the slider enabled when supportsSpeed is omitted', () => {
    const html = renderField({ provider: {} });

    expect(sliderTag(html)).not.toContain('disabled=""');
    expect(sliderTag(html)).toContain('value="1.5"');
    expect(html).not.toContain('settings.ttsSpeedUnsupported');
  });

  it('reads the capability from provider metadata, not from speedRange', () => {
    expect(TTS_PROVIDERS['google-tts'].supportsSpeed).toBe(false);
    expect(sliderTag(renderField({ provider: TTS_PROVIDERS['google-tts'] }))).toContain(
      'disabled=""',
    );

    expect(TTS_PROVIDERS['qwen-tts'].speedRange).toBeUndefined();
    expect(sliderTag(renderField({ provider: TTS_PROVIDERS['qwen-tts'] }))).not.toContain(
      'disabled=""',
    );
  });
});
