import { expect, it } from 'vitest';
import { stepsForWorkbench } from '@/lib/pbl/v3/onboarding';

it('uses the installed application capability without adding a learning step', () => {
  const without = stepsForWorkbench({});
  expect(without).toHaveLength(4);
  expect(without).not.toContain('application');
  const withApp = stepsForWorkbench({ application: { title: 'App', description: 'Try it' } });
  expect(withApp).toHaveLength(5);
  expect(withApp.filter((step) => step !== 'application')).toEqual(without);
});
