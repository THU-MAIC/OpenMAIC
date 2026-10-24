import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/workbench/WorkspaceEntry', () => ({
  WorkspaceEntry: () => null,
}));
vi.mock('@/app/classic-home', () => ({
  ClassicHomePage: () => null,
}));

import HomePage from '@/app/page';
import { ClassicHomePage } from '@/app/classic-home';
import { WorkspaceEntry } from '@/components/workbench/WorkspaceEntry';

/**
 * `/` through the real server gate. Only environment strings are set: the
 * database URL is a placeholder the gate checks for presence, never connected.
 */
const FLAGS = [
  'NEXT_PUBLIC_WORKBENCH_ENABLED',
  'NEXT_PUBLIC_PRO_WORKBENCH_ENABLED',
  'OPENMAIC_AGENT_RUNTIME_ENABLED',
  'DATABASE_URL',
] as const;

type Env = Partial<Record<(typeof FLAGS)[number], string>>;

const RUNTIME: Env = {
  OPENMAIC_AGENT_RUNTIME_ENABLED: 'true',
  DATABASE_URL: 'postgres://placeholder',
};

function rendersWorkspace(env: Env): boolean {
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  const home = HomePage() as ReactElement<{ children?: ReactElement }>;
  if (home.type === ClassicHomePage) return false;
  expect(home.props.children?.type).toBe(WorkspaceEntry);
  return true;
}

describe('the home page gate', () => {
  const originals = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of FLAGS) {
      originals.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of FLAGS) {
      const original = originals.get(name);
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    originals.clear();
  });

  it.each<[string, Env]>([
    ['no flag is set', {}],
    ['no public flag is set, even with the runtime configured', RUNTIME],
    ['the public flag is explicitly off', { NEXT_PUBLIC_WORKBENCH_ENABLED: 'false', ...RUNTIME }],
    [
      'the new name is off and overrides the previous name',
      {
        NEXT_PUBLIC_WORKBENCH_ENABLED: 'false',
        NEXT_PUBLIC_PRO_WORKBENCH_ENABLED: 'true',
        ...RUNTIME,
      },
    ],
    [
      'the runtime is off',
      { NEXT_PUBLIC_WORKBENCH_ENABLED: 'true', DATABASE_URL: 'postgres://placeholder' },
    ],
    [
      'the runtime has no database URL',
      { NEXT_PUBLIC_WORKBENCH_ENABLED: 'true', OPENMAIC_AGENT_RUNTIME_ENABLED: 'true' },
    ],
  ])('keeps the classic home when %s', (_case, env) => {
    expect(rendersWorkspace(env)).toBe(false);
  });

  it.each<[string, Env]>([
    ['the new name is on', { NEXT_PUBLIC_WORKBENCH_ENABLED: 'true', ...RUNTIME }],
    ['only the previous name is on', { NEXT_PUBLIC_PRO_WORKBENCH_ENABLED: 'true', ...RUNTIME }],
    [
      'the new name is empty and falls back to the previous name',
      {
        NEXT_PUBLIC_WORKBENCH_ENABLED: '',
        NEXT_PUBLIC_PRO_WORKBENCH_ENABLED: 'true',
        ...RUNTIME,
      },
    ],
  ])('renders the workspace when %s and the runtime is configured', (_case, env) => {
    expect(rendersWorkspace(env)).toBe(true);
  });
});
