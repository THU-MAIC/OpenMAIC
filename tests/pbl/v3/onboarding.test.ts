import { expect, it } from 'vitest';
import {
  hasSeenOnboarding,
  ONBOARDING_STORAGE_KEY,
  rememberOnboarding,
  stepsForWorkbench,
} from '@/lib/pbl/v3/onboarding';

it('uses the installed application capability without adding a learning step', () => {
  const without = stepsForWorkbench({});
  expect(without).toHaveLength(4);
  expect(without).not.toContain('application');
  const withApp = stepsForWorkbench({ application: { title: 'App', description: 'Try it' } });
  expect(withApp).toHaveLength(5);
  expect(withApp.filter((step) => step !== 'application')).toEqual(without);
});

it('keeps dismissal separate from learning storage and survives denied browser storage', () => {
  const values = new Map([['study-draft', 'Keep this draft']]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  expect(hasSeenOnboarding(storage)).toBe(false);
  expect(
    hasSeenOnboarding({
      getItem: () => {
        throw new Error('Denied');
      },
    }),
  ).toBe(false);
  rememberOnboarding(storage);
  expect(values.get(ONBOARDING_STORAGE_KEY)).toBe('seen');
  expect(values.get('study-draft')).toBe('Keep this draft');
  expect(hasSeenOnboarding(storage)).toBe(true);
  expect(() =>
    rememberOnboarding({
      setItem: () => {
        throw new Error('Quota');
      },
    }),
  ).not.toThrow();
  expect(hasSeenOnboarding(null)).toBe(true);
});
