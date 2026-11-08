import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/sandbox/store', () => ({ SandboxStore: { open: vi.fn() } }));
import { startCheckpointCollector } from '@/lib/server/sandbox/checkpoint-collector';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe('checkpoint collector schedule', () => {
  it('does not start without a database', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(startCheckpointCollector()).toBeUndefined();
  });
  it('runs once, retries on its own timer, and stops without owning the shared pool', async () => {
    vi.useFakeTimers();
    vi.stubEnv('OPENMAIC_SANDBOX_PROVIDER', 'e2b-compatible');
    vi.stubEnv('DATABASE_URL', 'fixture');
    const collect = vi.fn().mockResolvedValue({ collected: 1, deferred: 0 });
    const schedule = startCheckpointCollector(collect)!;
    expect(startCheckpointCollector(collect)).toBe(schedule);
    await Promise.resolve();
    await Promise.resolve();
    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(collect).toHaveBeenCalledTimes(2);
    await schedule.stop();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(collect).toHaveBeenCalledTimes(2);
  });
});
