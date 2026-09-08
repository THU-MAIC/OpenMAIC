import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  ensureTeacherLocalConfig,
  teacherLocalEnvironment,
} from '@/scripts/setup-teacher-local.mjs';

describe('local teacher setup', () => {
  it('generates one existing PostgreSQL deployment with matching credentials', () => {
    const values = parseEnv(teacherLocalEnvironment(55432, 'a'.repeat(48), 'b'.repeat(48)));
    expect(new URL(values.DATABASE_URL!).hostname).toBe('127.0.0.1');
    expect(new URL(values.DATABASE_URL!).password).toBe(values.PERSISTENCE_POSTGRES_PASSWORD);
    expect(values.PERSISTENCE_DEV_TOKEN).toBe(values.NEXT_PUBLIC_PERSISTENCE_TOKEN);
    expect(values.OPENMAIC_AGENT_RUNTIME_ENABLED).toBe('true');
  });

  it.each([0, 80, 65536, 55432.5, NaN])('rejects invalid port %s before writing config', (port) => {
    expect(() => teacherLocalEnvironment(port, 'a'.repeat(48), 'b'.repeat(48))).toThrow();
  });

  it('does not replace configuration or credentials when rerun', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teacher-setup-fixture-'));
    await expect(ensureTeacherLocalConfig(directory, 55432)).resolves.toEqual({ created: true });
    const original = await readFile(join(directory, '.env.local'), 'utf8');
    await expect(ensureTeacherLocalConfig(directory, 55432)).resolves.toEqual({ created: false });
    expect(await readFile(join(directory, '.env.local'), 'utf8')).toBe(original);
    await expect(ensureTeacherLocalConfig(directory, 55433)).rejects.toThrow('different port');
    expect(await readFile(join(directory, '.env.local'), 'utf8')).toBe(original);
  });

  it('preserves a preexisting user deployment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teacher-existing-fixture-'));
    const original = 'DATABASE_URL=postgres://fictional-existing-deployment\n';
    await writeFile(join(directory, '.env.local'), original);
    await expect(ensureTeacherLocalConfig(directory, 55432)).rejects.toThrow('preserved');
    expect(await readFile(join(directory, '.env.local'), 'utf8')).toBe(original);
  });
});
