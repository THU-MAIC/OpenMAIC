import type { StatelessEvent } from '@/lib/types/chat';

export type SendEvent = (event: StatelessEvent) => Promise<void>;
