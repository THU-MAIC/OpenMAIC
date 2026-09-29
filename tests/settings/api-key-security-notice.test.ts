import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cases = [
  ['web search / Brave', 'components/settings/web-search-settings.tsx', '<ApiKeySecurityNotice />'],
  [
    'TTS / Lemonade',
    'components/settings/tts-settings.tsx',
    '!isVoxCPM && <ApiKeySecurityNotice />',
  ],
  ['image / ComfyUI', 'components/settings/image-settings.tsx', '<ApiKeySecurityNotice />'],
  ['ASR / Lemonade', 'components/settings/asr-settings.tsx', '<ApiKeySecurityNotice />'],
  [
    'PDF / AliDocMind',
    'components/settings/pdf-settings.tsx',
    '(isCloud || isAliDocMind) && <ApiKeySecurityNotice />',
  ],
  ['video', 'components/settings/video-settings.tsx', '<ApiKeySecurityNotice />'],
] as const;

describe('credential security notices', () => {
  it.each(cases)('keeps the notice in the %s credential panel', (_name, file, marker) => {
    expect(readFileSync(resolve(process.cwd(), file), 'utf8')).toContain(marker);
  });

  it('uses credential-neutral wording', () => {
    const locale = JSON.parse(
      readFileSync(resolve(process.cwd(), 'lib/i18n/locales/en-US.json'), 'utf8'),
    ) as { settings: { apiKeySecurityNotice: string } };
    expect(locale.settings.apiKeySecurityNotice).toContain('Credentials');
    expect(locale.settings.apiKeySecurityNotice).not.toContain('Your API key');
  });
});
