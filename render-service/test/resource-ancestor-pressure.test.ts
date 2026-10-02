import { expect, it, vi } from 'vitest';
import {
  compareAncestorPressure,
  createAncestorPressureMonitor,
  type AncestorPressureRow,
} from '../src/resource-ancestor-pressure.mjs';

function row(events = 'high 0\nmax 0\noom 0\noom_kill 0'): AncestorPressureRow {
  return {
    path: '/sys/fs/cgroup/system.slice',
    memoryCurrent: '4096',
    memoryHigh: 'max',
    memoryMax: '805306368',
    memoryEventsLocal: events,
  };
}

it('attributes only local ancestor high/max/oom pressure, not victim counts', () => {
  expect(
    compareAncestorPressure([row()], [row('high 0\nmax 0\noom 0\noom_kill 2')]).triggers,
  ).toEqual([]);
  expect(
    compareAncestorPressure([row()], [row('high 1\nmax 2\noom 1\noom_kill 2')]).triggers,
  ).toEqual([
    expect.objectContaining({ event: 'high', before: '0', after: '1' }),
    expect.objectContaining({ event: 'max', before: '0', after: '2' }),
    expect.objectContaining({ event: 'oom', before: '0', after: '1' }),
  ]);
});

it('fails closed on missing counters, resets, identity changes and an active memory.high', () => {
  expect(() => compareAncestorPressure([row()], [row('high 0\nmax 0')])).toThrow('Missing');
  expect(() => compareAncestorPressure([row('high 1\nmax 0\noom 0')], [row()])).toThrow('reset');
  expect(() => compareAncestorPressure([row()], [])).toThrow('identity');
  expect(
    compareAncestorPressure([row()], [{ ...row(), memoryCurrent: '4096', memoryHigh: '4096' }])
      .triggers,
  ).toEqual([expect.objectContaining({ event: 'at-memory.high' })]);
});

it('derives the task slice and permanently closes on a sampled local event', () => {
  let events = 'high 0\nmax 0\noom 0\noom_kill 0';
  const readFile = vi.fn((path: string) => {
    if (path.endsWith('memory.current')) return '4096\n';
    if (path.endsWith('memory.high')) return 'max\n';
    if (path.endsWith('memory.max')) return '805306368\n';
    if (path.endsWith('memory.events.local')) return `${events}\n`;
    throw new Error(`Unexpected read ${path}`);
  });
  const monitor = createAncestorPressureMonitor({
    membership: '0::/system.slice/openmaic-resource.service\n',
    readFile,
  });
  expect(monitor.taskSlice).toBe('system.slice');
  expect(monitor.paths).toEqual(['/sys/fs/cgroup/system.slice']);
  expect(monitor.check()).toBe(true);
  events = 'high 0\nmax 1\noom 0\noom_kill 0';
  expect(monitor.check()).toBe(false);
  expect(monitor.failure()).toMatchObject({ reason: 'ancestor_memory_pressure' });
  events = 'high 0\nmax 0\noom 0\noom_kill 0';
  expect(monitor.check()).toBe(false);
});

it('makes pressure collection failure observable and fail-closed', () => {
  let fail = false;
  const readFile = (path: string) => {
    if (fail && path.endsWith('memory.events.local'))
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    if (path.endsWith('memory.current')) return '4096';
    if (path.endsWith('memory.high')) return 'max';
    if (path.endsWith('memory.max')) return '805306368';
    if (path.endsWith('memory.events.local')) return 'high 0\nmax 0\noom 0\noom_kill 0';
    throw new Error(`Unexpected read ${path}`);
  };
  const monitor = createAncestorPressureMonitor({
    membership: '0::/system.slice/openmaic-resource.service',
    readFile,
  });
  fail = true;
  expect(monitor.check()).toBe(false);
  expect(monitor.failure()).toMatchObject({
    reason: 'ancestor_pressure_unverifiable',
    details: { error: expect.stringContaining('permission denied') },
  });
});
