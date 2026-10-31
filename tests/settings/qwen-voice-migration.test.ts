import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';
const state = vi.hoisted(() => ({ profiles: [] as { id: string; name: string }[] }));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) =>
      enUS.settings[key.replace('settings.', '') as keyof typeof enUS.settings] ?? key,
  }),
}));
vi.mock('@/lib/audio/voxcpm-voices', async (original) => ({
  ...(await original<typeof import('@/lib/audio/voxcpm-voices')>()),
  useQwenVoiceProfiles: () => ({ profiles: state.profiles }),
}));
vi.mock('@/lib/audio/use-tts-preview', () => ({
  useTTSPreview: () => ({ previewing: false, stopPreview: () => {} }),
}));
import { QwenVoiceCloneManager } from '@/components/settings/tts-voice-managers';
it.each([undefined, 'cosyvoice-v3.5-plus-new-id', 'operator-target-id'])(
  'does not show a retirement notice for %s',
  (id) => {
    state.profiles = id ? [{ id, name: 'Saved voice' }] : [];
    const html = renderToStaticMarkup(createElement(QwenVoiceCloneManager));
    expect(html).toContain('5–60');
    expect(html).not.toMatch(/retired|cloned again/i);
  },
);
it.each(['qwen-tts-vc-old-id', 'qwen3-tts-vc-2026-01-22-old-id'])(
  'keeps actionable migration guidance for saved %s',
  (id) => {
    state.profiles = [{ id, name: 'Saved voice' }];
    const html = renderToStaticMarkup(createElement(QwenVoiceCloneManager));
    expect(html).toContain('role="status"');
    expect(html).toMatch(/reference|recording|audio/i);
    expect(html).toMatch(/cloned again/i);
    expect(html).toContain('Saved voice');
  },
);
