import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentThreadStore } from '@/lib/agent/client/agent-thread-store';

const thread = (text: string) => ({
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }],
  updatedAt: 0,
});

describe('useAgentThreadStore', () => {
  beforeEach(() => useAgentThreadStore.setState({ threads: {} }));

  it('save then load returns the thread for that stage', () => {
    useAgentThreadStore.getState().save('stage-a', thread('hello'));
    expect(useAgentThreadStore.getState().load('stage-a')).toEqual(thread('hello'));
  });

  it('isolates threads per stage', () => {
    useAgentThreadStore.getState().save('stage-a', thread('a'));
    useAgentThreadStore.getState().save('stage-b', thread('b'));
    expect(useAgentThreadStore.getState().load('stage-a')).toEqual(thread('a'));
    expect(useAgentThreadStore.getState().load('stage-b')).toEqual(thread('b'));
  });

  it('clear removes only that stage', () => {
    useAgentThreadStore.getState().save('stage-a', thread('a'));
    useAgentThreadStore.getState().save('stage-b', thread('b'));
    useAgentThreadStore.getState().clear('stage-a');
    expect(useAgentThreadStore.getState().load('stage-a')).toBeUndefined();
    expect(useAgentThreadStore.getState().load('stage-b')).toEqual(thread('b'));
  });
});
