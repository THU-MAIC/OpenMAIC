import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUEUED_OPENING_KEY, queuedOpeningMessage } from '@/lib/workbench/queued-session';
import { createWorkbenchTranslator } from '@/lib/i18n/workbench';
import {
  createInitialSessionState,
  foldEvent,
  type ChatNode,
  type WorkbenchFold,
} from '@/lib/workbench/session-store';

const prompt = 'Explain why the sky is blue in 5 pages, for middle-school students';

describe('a request waiting in the queue', () => {
  it("shows the user's own request before the runner claims it", () => {
    expect(queuedOpeningMessage({ status: 'queued', chat: [], prompt })).toEqual({
      key: QUEUED_OPENING_KEY,
      kind: 'user',
      text: prompt,
    });
  });

  it('adds nothing once the transcript has a message, or when not queued', () => {
    const asked: ChatNode[] = [{ key: 'u', kind: 'user', text: 'follow-up', at: 1 }];
    expect(queuedOpeningMessage({ status: 'queued', chat: asked, prompt })).toBeNull();
    for (const status of ['running', 'connecting', 'succeeded', 'idle'] as const)
      expect(queuedOpeningMessage({ status, chat: [], prompt })).toBeNull();
    expect(queuedOpeningMessage({ status: 'queued', chat: [], prompt: '  ' })).toBeNull();
    expect(queuedOpeningMessage({ status: 'queued', chat: [], prompt: null })).toBeNull();
  });

  it('gives way to the runner’s own bubble on claim, without a second copy', () => {
    const claimed = [[1_000, 'session_start', { prompt }]] as const;
    const state = claimed.reduce<WorkbenchFold>(
      (current, [ts, type, data], index) =>
        foldEvent(current, { id: index + 1, ts, attempt: 1, type, data }),
      createInitialSessionState(),
    );
    expect(state.chat.filter((node) => node.kind === 'user')).toHaveLength(1);
    // Running now: the stand-in is gone, the runner's bubble is the one.
    expect(queuedOpeningMessage({ status: state.status, chat: state.chat, prompt })).toBeNull();
  });

  it('has its copy in both base languages', () => {
    for (const locale of ['zh-CN', 'en-US', 'zh-TW']) {
      const t = createWorkbenchTranslator(locale);
      for (const key of [
        'workbench.chat.queued',
        'workbench.chat.queuedPlaceholder',
        'workbench.chat.cancelQueued',
        'workbench.preview.queued',
        'workbench.preview.queuedDesc',
        'workbench.preview.queuedEyebrow',
      ] as const)
        expect(t(key), `${locale} ${key}`).not.toBe(key);
    }
    expect(createWorkbenchTranslator('en-US')('workbench.chat.queued')).toBe(
      'In the queue — it starts on its own when a slot frees up',
    );
  });

  it('is wired into the conversation: the bubble, the notice, the composer', () => {
    const chat = readFileSync(
      resolve(process.cwd(), 'components/workbench/WorkbenchChat.tsx'),
      'utf8',
    );
    expect(chat).toContain('() => queuedOpeningMessage({ status, chat, prompt: sessionPrompt }),');
    expect(chat).toContain('const opening = openingMessage ?? queuedOpening;');
    expect(chat).toContain('{queued && !catchingUp ? <QueuedNotice t={t} /> : null}');
    expect(chat).toContain("? 'workbench.chat.queuedPlaceholder'");
    expect(chat).toContain("? 'workbench.chat.cancelQueued'");
  });
});
