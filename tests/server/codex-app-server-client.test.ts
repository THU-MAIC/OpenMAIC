import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '@/lib/server/codex/app-server-client';

interface FakeProcess {
  child: ChildProcessWithoutNullStreams;
  messages: Array<Record<string, unknown>>;
  send: (message: Record<string, unknown>) => void;
}

function createFakeProcess(
  responseFor: (message: Record<string, unknown>) => unknown = () => ({}),
): FakeProcess {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const messages: Array<Record<string, unknown>> = [];

  Object.assign(process, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    killed: false,
    kill: vi.fn(() => true),
  });

  let buffer = '';
  stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      if (typeof message.id === 'number' && typeof message.method === 'string') {
        stdout.write(`${JSON.stringify({ id: message.id, result: responseFor(message) })}\n`);
      }
    }
  });

  return {
    child: process,
    messages,
    send: (message) => stdout.write(`${JSON.stringify(message)}\n`),
  };
}

describe('Codex App Server client', () => {
  it('initializes once and exchanges JSONL requests', async () => {
    const fake = createFakeProcess((message) =>
      message.method === 'account/read' ? { account: null } : {},
    );
    const factory = vi.fn(() => fake.child);
    const client = new CodexAppServerClient(factory);

    await expect(client.request('account/read', { refreshToken: false })).resolves.toEqual({
      account: null,
    });
    await client.request('model/list');

    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.messages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'model/list',
    ]);
    expect(fake.messages[0]).toMatchObject({
      params: { clientInfo: { name: 'openmaic' } },
    });
    client.dispose();
  });

  it('forwards notifications and rejects unsupported server callbacks', async () => {
    const fake = createFakeProcess();
    const client = new CodexAppServerClient(() => fake.child);
    await client.request('account/read');

    const notification = vi.fn();
    client.onNotification(notification);
    fake.send({ method: 'account/updated', params: { authMode: 'chatgpt' } });
    fake.send({ id: 91, method: 'item/tool/call', params: {} });

    await vi.waitFor(() =>
      expect(notification).toHaveBeenCalledWith('account/updated', {
        authMode: 'chatgpt',
      }),
    );
    await vi.waitFor(() =>
      expect(fake.messages).toContainEqual({
        id: 91,
        error: {
          code: -32601,
          message: 'OpenMAIC does not expose App Server callback tools.',
        },
      }),
    );
    client.dispose();
  });
});
