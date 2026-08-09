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
