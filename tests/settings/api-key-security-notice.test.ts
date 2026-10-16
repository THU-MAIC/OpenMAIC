import { readdirSync, readFileSync } from 'node:fs';
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

  it('covers every password input in settings panels', () => {
    const files = readdirSync(resolve(process.cwd(), 'components/settings'), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
      .map((entry) => resolve(entry.parentPath, entry.name));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!/type\s*=\s*(?:["']password["']|\{[^}]*["']password["'][^}]*\})/.test(source)) continue;
      if (file.endsWith('server-settings.tsx')) continue;
      expect(source, `${file} must render CredentialStorageHint`).toMatch(
        /<CredentialStorageHint\b/,
      );
    }
  });

  it('uses credential-neutral wording', () => {
    const locale = JSON.parse(
      readFileSync(resolve(process.cwd(), 'lib/i18n/locales/en-US.json'), 'utf8'),
    ) as { settings: { credentialStorageHint: string; credentialStorageHintDetail: string } };
    expect(locale.settings.credentialStorageHint).toContain('Encrypted');
    expect(locale.settings.credentialStorageHintDetail).toContain('operator');
  });
});
