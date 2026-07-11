import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * Wiring guard: every PBL v2 *runtime* route must forward its MODEL_ROUTES
 * stage into model resolution, so operators can pin the shared runtime model
 * through `pbl-v2-runtime` or override a specific endpoint via
 * `pbl-v2-runtime:<endpoint>`.
 */
const mocks = vi.hoisted(() => ({
  resolveModelFromRequest: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));
vi.mock('@/lib/pbl/v2/api/sse', () => ({
  createSSEResponse: vi.fn(() => new Response('ok')),
}));
vi.mock('@/lib/pbl/v2/api/locale', () => ({
  applyRequestLocaleToProject: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/agents/instructor', () => ({
  runInstructorTurn: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/agents/simulator', () => ({
  runSimulatorTurn: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/agents/evaluator', () => ({
  runTaskEvaluation: vi.fn(),
  runMilestoneEvaluation: vi.fn(),
  runFinalEvaluation: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/operations/quiz-snapshot', () => ({
  applyQuizSignalsToProject: vi.fn(() => ({ updated: false, tierChanged: false })),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/pbl/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('PBL v2 runtime routes forward MODEL_ROUTES stages', () => {
  beforeEach(() => {
    mocks.resolveModelFromRequest.mockReset();
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: {},
      thinkingConfig: undefined,
      modelInfo: null,
    });
  });

  it('instructor route forwards its runtime stage', async () => {
    const { POST } = await import('@/app/api/pbl/v2/instructor/route');
    await POST(makeRequest({ project: { id: 'p' }, userMessage: 'hi' }));
    expect(mocks.resolveModelFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'pbl-v2-runtime:instructor',
    );
  });

  it('evaluate route forwards its runtime stage', async () => {
    const { POST } = await import('@/app/api/pbl/v2/evaluate/route');
    await POST(makeRequest({ project: { id: 'p' }, kind: 'final' }));
    expect(mocks.resolveModelFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'pbl-v2-runtime:evaluate',
    );
  });

  it('open-task route forwards its runtime stage', async () => {
    const { POST } = await import('@/app/api/pbl/v2/open-task/route');
    await POST(makeRequest({ project: { id: 'p' }, phase: 'greeting' }));
    expect(mocks.resolveModelFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'pbl-v2-runtime:open-task',
    );
  });

  it('simulator route forwards its runtime stage', async () => {
    const { POST } = await import('@/app/api/pbl/v2/simulator/route');
    await POST(makeRequest({ project: { id: 'p' }, userMessage: 'hi' }));
    expect(mocks.resolveModelFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'pbl-v2-runtime:simulator',
    );
  });
});
