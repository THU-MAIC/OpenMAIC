import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enterEditMode } from '@/lib/edit/enter-edit-mode';

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('multi-tab edit mode', () => {
  it('lets independent tabs enter only after their own teardown and preload finish', async () => {
    const events: string[] = [];
    let finishFirstTeardown!: () => void;
    let finishSecondPreload!: () => void;

    const first = enterEditMode({
      teardown: () =>
        new Promise<void>((resolve) => {
          finishFirstTeardown = resolve;
        }),
      preload: async () => undefined,
      activate: () => events.push('first'),
      onError: () => undefined,
    });
    const second = enterEditMode({
      teardown: async () => undefined,
      preload: () =>
        new Promise<void>((resolve) => {
          finishSecondPreload = resolve;
        }),
      activate: () => events.push('second'),
      onError: () => undefined,
    });

    await Promise.resolve();
    expect(events).toEqual([]);

    finishSecondPreload();
    await second;
    expect(events).toEqual(['second']);

    finishFirstTeardown();
    await first;
    expect(events).toEqual(['second', 'first']);
  });

  it.each([
    {
      source: 'teardown',
      teardown: () => Promise.reject(new Error('teardown failed')),
      preload: async () => undefined,
    },
    {
      source: 'preload',
      teardown: async () => undefined,
      preload: () => {
        throw new Error('preload failed');
      },
    },
  ])('stays in playback when $source fails', async ({ teardown, preload }) => {
    const errors: unknown[] = [];
    let activated = false;

    await expect(
      enterEditMode({
        teardown,
        preload,
        activate: () => {
          activated = true;
        },
        onError: (error) => errors.push(error),
      }),
    ).resolves.toBe(false);

    expect(activated).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('does not reference the former cross-tab lock from the edit entry flow', () => {
    const editEntrySources = [
      source('components/stage.tsx'),
      source('components/edit/PlaybackChromeRoot.tsx'),
    ].join('\n');

    expect(editEntrySources).not.toMatch(
      /useEditModeLock|MultiTabEditConflictPrompt|tryAcquireEditLock|editLock|cross-tab edit lock/,
    );
  });

  it('does not ship the former lock lifecycle or conflict prompt', () => {
    for (const path of [
      'components/edit/use-edit-mode-lock.ts',
      'components/edit/MultiTabEditConflictPrompt.tsx',
      'lib/edit/edit-mode-lock.ts',
    ]) {
      expect(existsSync(new URL(`../../${path}`, import.meta.url)), path).toBe(false);
    }
  });

  it('does not expose lock-only translations', () => {
    const localesDir = new URL('../../lib/i18n/locales/', import.meta.url);
    for (const file of readdirSync(localesDir).filter((name) => name.endsWith('.json'))) {
      const locale = JSON.parse(readFileSync(new URL(file, localesDir), 'utf8')) as {
        edit?: Record<string, unknown>;
      };
      expect(locale.edit, file).not.toHaveProperty('multiTab');
    }
  });
});
