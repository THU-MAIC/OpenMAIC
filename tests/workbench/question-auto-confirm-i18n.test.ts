/**
 * The auto-confirm copy is written in every locale itself, not left to fall
 * back: the workbench overlays merge onto English, so a missing key would pass
 * the generic completeness check while showing English to everyone else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { supportedLocales } from '@/lib/i18n/locales';
import { workbenchEn, workbenchZh } from '@/lib/i18n/workbench';

const QUESTION_KEYS = [
  'dismiss',
  'recommended',
  'autoConfirm',
  'autoConfirmed',
  'showDetails',
  'hideDetails',
  'orAnswerInChat',
] as const;

const SETTINGS_KEYS = ['autoConfirmRecommended', 'autoConfirmRecommendedDesc'] as const;

const read = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), file), 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;

describe('auto-confirm copy', () => {
  it('is in both base workbench maps', () => {
    for (const base of [workbenchEn, workbenchZh]) {
      for (const key of QUESTION_KEYS) {
        expect(String(base.question[key]).trim()).not.toBe('');
      }
    }
    // The form's way out hands the composer back; it no longer reads as giving up.
    expect(workbenchEn.question.dismiss).toBe('Collapse');
    expect(workbenchZh.question.dismiss).toBe('收起');
  });

  it('is in every workbench overlay file', () => {
    const dir = 'lib/i18n/workbench-locales';
    for (const file of fs.readdirSync(path.join(process.cwd(), dir))) {
      const question = read(`${dir}/${file}`).question;
      for (const key of QUESTION_KEYS) {
        expect(typeof question[key], `${file} question.${key}`).toBe('string');
      }
    }
  });

  it('has the settings toggle in every supported locale', () => {
    for (const { code } of supportedLocales) {
      const settings = read(`lib/i18n/locales/${code}.json`).settings;
      for (const key of SETTINGS_KEYS) {
        expect(String(settings[key] ?? '').trim(), `${code} settings.${key}`).not.toBe('');
      }
    }
  });
});
