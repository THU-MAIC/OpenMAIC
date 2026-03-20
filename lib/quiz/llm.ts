import { callLLM } from '@/lib/ai/llm';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import type { NextRequest } from 'next/server';

export async function callQuizLLM(req: NextRequest, system: string, prompt: string, source: string) {
  const { model } = resolveModelFromHeaders(req);
  return callLLM({ model, system, prompt }, source, { retries: 1 });
}
