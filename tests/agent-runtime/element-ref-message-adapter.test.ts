import { describe, expect, it, vi } from 'vitest';
import { listAgentUserMessages } from '@/lib/server/agent-runtime/user-messages';

describe('agent user-message element-ref adapter', () => {
  it('recovers persisted element refs from authoritative event JSON', async () => {
    const elementRef = {
      kind: 'interactive-element',
      stageId: 'stage-1',
      sceneId: 'scene-web',
      selector: '#cta',
      outerHTML: '<button id="cta">Start</button>',
      text: 'Start',
      label: 'button · Start',
    };
    const readEventsAfter = vi.fn(async (_sessionId: string, cursor: number) =>
      cursor === 0
        ? [
            {
              id: 4,
              ts: 100,
              attempt: 0,
              type: 'user_message',
              data: {
                text: 'Rename it',
                delivery: 'queued',
                elementRefs: [elementRef],
              },
            },
          ]
        : [],
    );

    await expect(listAgentUserMessages({ readEventsAfter } as never, 'session-1')).resolves.toEqual(
      [
        {
          seq: 4,
          ts: 100,
          text: 'Rename it',
          delivery: 'queued',
          materials: [],
          elementRefs: [elementRef],
        },
      ],
    );
  });
});
