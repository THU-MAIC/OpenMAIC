/**
 * Regression tests for issue #664: PBL generation is the only path that
 * requires native tool calling, and models without tool support reject the
 * request outright with a raw provider error (e.g. an immediate 500 from
 * LM Studio when the chat template has no tools section).
 *
 * A rejection before the first agentic step must be wrapped with an
 * actionable message naming the tool-calling requirement; a failure after
 * steps have completed must keep its original error (no misdiagnosis).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ai/llm', () => ({
  callLLM: vi.fn(),
}));

import { callLLM } from '@/lib/ai/llm';
import { generatePBLContent, type GeneratePBLConfig } from '@/lib/pbl/generate-pbl';
import type { LanguageModel } from 'ai';

type StepCallback = (step: { toolCalls: unknown[]; text: string }) => void;

const config: GeneratePBLConfig = {
  projectTopic: 'Bridge building',
  projectDescription: 'Design and stress-test a model bridge',
  targetSkills: ['statics'],
  languageDirective: 'Respond in English.',
};

const model = {} as unknown as LanguageModel;

describe('generatePBLContent tool-rejection context (issue #664)', () => {
  beforeEach(() => {
    vi.mocked(callLLM).mockReset();
  });

  it('wraps a rejection before the first step with the tool-calling requirement', async () => {
    vi.mocked(callLLM).mockRejectedValue(
      new Error('500 status: this model template does not support tools'),
    );

    await expect(generatePBLContent(config, model)).rejects.toThrow(
      /must support tool calling[\s\S]*Original error: 500 status: this model template does not support tools/,
    );
  });

  it('keeps the original error when the loop fails after completing a step', async () => {
    vi.mocked(callLLM).mockImplementation(async (params) => {
      // Simulate one completed agentic step, then a mid-loop failure.
      (params as { onStepFinish?: StepCallback }).onStepFinish?.({ toolCalls: [], text: 'plan' });
      throw new Error('network reset mid-loop');
    });

    const failure = generatePBLContent(config, model);
    await expect(failure).rejects.toThrow('network reset mid-loop');
    await expect(failure).rejects.not.toThrow(/must support tool calling/);
  });
});
