import type { CallLlmStreamFnOptions } from '@/lib/agent/runtime/stream-fn';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessEvent } from '@/lib/types/chat';

export type SendEvent = (event: StatelessEvent) => Promise<void>;

export interface DirectorToolTraceEntry {
  sequence: number;
  toolName: string;
  args: unknown;
  isError: boolean;
  resultPreview: string;
  details?: unknown;
}

/** In-process transport injection; never accepted from a chat request. */
export type PiStreamFnFactory = (options: CallLlmStreamFnOptions, agent?: AgentConfig) => StreamFn;
