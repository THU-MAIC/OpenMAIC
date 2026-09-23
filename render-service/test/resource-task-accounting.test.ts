import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readTaskAccounting } from '../src/resource-task-runner.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function accountingFixture() {
  const root = mkdtempSync(join(tmpdir(), 'resource-accounting-'));
  roots.push(root);
  mkdirSync(join(root, 'task'));
  const task = join(root, 'task');
  const values = {
    'memory.current': '131072\n',
    'memory.events': 'low 0\nhigh 1\nmax 2\noom 1\noom_kill 1\n',
    'memory.events.local': 'low 0\nhigh 0\nmax 2\noom 1\noom_kill 1\n',
    'cpu.stat': 'usage_usec 4321\nuser_usec 3000\nsystem_usec 1321\n',
    'pids.current': '1\n',
    'pids.events': 'max 0\n',
  };
  for (const [name, value] of Object.entries(values)) writeFileSync(join(task, name), value);
  return task;
}

it('captures the complete task accounting contract before cgroup removal', () => {
  expect(readTaskAccounting(accountingFixture())).toEqual({
    status: 'CAPTURED',
    measurements: {
      memoryCurrent: '131072',
      memoryEvents: 'low 0\nhigh 1\nmax 2\noom 1\noom_kill 1',
      memoryEventsLocal: 'low 0\nhigh 0\nmax 2\noom 1\noom_kill 1',
      cpuStat: 'usage_usec 4321\nuser_usec 3000\nsystem_usec 1321',
      pidsCurrent: '1',
      pidsEvents: 'max 0',
    },
    errors: {},
  });
});

it('reports a missing accounting field without fabricating its value', () => {
  const task = accountingFixture();
  rmSync(join(task, 'cpu.stat'));
  const result = readTaskAccounting(task);
  expect(result.status).toBe('COLLECTION_FAILED');
  expect(result.measurements).not.toHaveProperty('cpuStat');
  expect(result.errors).toMatchObject({
    cpuStat: { code: 'ENOENT', message: expect.stringContaining('cpu.stat') },
  });
  expect(result.measurements).toMatchObject({ memoryCurrent: '131072', pidsCurrent: '1' });
});
