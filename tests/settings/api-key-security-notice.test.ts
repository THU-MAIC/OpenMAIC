import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('credential security notices', () => {
  it('renders the hint from the shared API key field', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'components/settings/server-settings.tsx'),
      'utf8',
    );
    expect(source).toContain('export function CredentialStorageHint');
    expect(source).toContain('<CredentialStorageHint />');
  });

  it('covers credential inputs that do not use the shared API key field', () => {
    for (const file of [
      'components/settings/tts-settings.tsx',
      'components/settings/token-plan-settings.tsx',
    ]) {
      expect(readFileSync(resolve(process.cwd(), file), 'utf8')).toContain('CredentialStorageHint');
    }
  });

  it('uses credential-neutral wording', () => {
    const locale = JSON.parse(
      readFileSync(resolve(process.cwd(), 'lib/i18n/locales/en-US.json'), 'utf8'),
    ) as { settings: { credentialStorageHint: string } };
    expect(locale.settings.credentialStorageHint).toContain('encrypted');
    expect(locale.settings.credentialStorageHint).toContain('operator');
  });
});
