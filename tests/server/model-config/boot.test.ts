import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// register() is exercised for its model configuration check only.
vi.mock('@/lib/persistence/asset-quota', () => ({ resolveAssetQuotaBytes: vi.fn() }));
vi.mock('@/lib/persistence/asset-pending-ttl', () => ({ resolveAssetPendingTtlMs: vi.fn() }));
const startAssetCollectorSchedule = vi.hoisted(() => vi.fn());
vi.mock('@/lib/persistence/schema-boot-check', () => ({ startSchemaBootCheck: vi.fn() }));
vi.mock('@/lib/persistence/asset-collector-schedule', () => ({ startAssetCollectorSchedule }));
vi.mock('@/lib/server/config-validation', () => ({ validateServerConfig: vi.fn() }));
vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: () => false }));

let exit: ReturnType<typeof vi.spyOn>;
let stderr: string[];
let dir: string;

beforeEach(async () => {
  // The deployment configuration is loaded once per process; each case boots anew.
  (await import('@/lib/server/model-config/runtime')).setDeploymentConfigForTests();
  stderr = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmaic-boot-'));
  startAssetCollectorSchedule.mockReset();
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: string | Uint8Array,
    callback?: () => void,
  ) => {
    stderr.push(String(chunk));
    callback?.();
    return true;
  }) as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(process, 'once').mockReturnValue(process);
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
  vi.stubEnv('DATABASE_URL', 'postgres://boot/openmaic');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function configFile(text: string): string {
  const file = path.join(dir, 'openmaic.yml');
  fs.writeFileSync(file, text);
  return file;
}

describe('model configuration at boot', () => {
  it('exits the server when the configuration file is invalid, before anything starts', async () => {
    vi.stubEnv('OPENMAIC_CONFIG', configFile('slots:\n  llm: ghost:model\n'));
    const { register } = await import('@/instrumentation');

    await expect(register()).rejects.toThrow(/Invalid model configuration/);

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^\[boot\] Invalid server configuration; the server will not start:/);
    expect(stderr[0]).toContain('slots.llm: provider "ghost" is not declared under providers');
    expect(startAssetCollectorSchedule).not.toHaveBeenCalled();
  });

  it('boots unchanged without a configuration file', async () => {
    vi.stubEnv('OPENMAIC_CONFIG', '');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();

    expect(exit).not.toHaveBeenCalled();
    expect(startAssetCollectorSchedule).toHaveBeenCalledOnce();
  });

  it('refuses to start with MODEL_ROUTES and no configuration file', async () => {
    vi.stubEnv('OPENMAIC_CONFIG', '');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.stubEnv('MODEL_ROUTES', '{"scene-content":"openai:gpt-5.6"}');
    const { register } = await import('@/instrumentation');

    await expect(register()).rejects.toThrow(/MODEL_ROUTES does not carry over/);

    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr[0]).toContain('write the per-stage models as slots in openmaic.yml');
    expect(startAssetCollectorSchedule).not.toHaveBeenCalled();
  });

  it('boots with MODEL_ROUTES left over next to a configuration file', async () => {
    vi.stubEnv('MODEL_ROUTES', '{"scene-content":"openai:gpt-5.6"}');
    vi.stubEnv('OPENMAIC_CONFIG', configFile('slots:\n  video: null\n'));
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();

    expect(exit).not.toHaveBeenCalled();
  });

  it('boots with a valid configuration file', async () => {
    vi.stubEnv('MINIMAX_API_KEY', 'sk-test');
    vi.stubEnv(
      'OPENMAIC_CONFIG',
      configFile(
        'providers:\n  minimax:\n    preset: minimax\n    apiKey: ${MINIMAX_API_KEY}\nslots:\n  llm: minimax:MiniMax-M3\n',
      ),
    );
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();

    expect(exit).not.toHaveBeenCalled();
    expect(startAssetCollectorSchedule).toHaveBeenCalledOnce();
  });
});
