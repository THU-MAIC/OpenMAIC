// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_FIX_STAGED_TTL_MS,
  agentFixPageLabel,
  dropStagedAgentFix,
  nextAgentFixSeedKey,
  peekStagedAgentFix,
  stageAgentFixForWorkspace,
} from '@/lib/workbench/agent-fix-handoff';

const KEY = 'openmaic.agentFixHandoff';

describe('fix with agent: how a page is named', () => {
  it('numbers the page from one and names an untitled page', () => {
    const t = (key: string, options?: Record<string, unknown>) =>
      key === 'edit.issues.pageLabel'
        ? `Page ${String(options?.index)} · ${String(options?.title)}`
        : 'Untitled page';
    expect(agentFixPageLabel(t, 1, ' Graph ')).toBe('Page 2 · Graph');
    expect(agentFixPageLabel(t, 0, '  ')).toBe('Page 1 · Untitled page');
  });
});

describe('fix with agent: the standalone classroom hand-off', () => {
  afterEach(() => window.sessionStorage.clear());

  it('stages one request for the workspace and keeps it until taken', () => {
    stageAgentFixForWorkspace({ courseId: 'course-1', prefill: 'Fix it' }, 1_000);
    expect(peekStagedAgentFix(2_000)).toEqual({ courseId: 'course-1', prefill: 'Fix it' });
    // Peeking does not take it; dropping does.
    expect(peekStagedAgentFix(2_000)).not.toBeNull();
    dropStagedAgentFix();
    expect(peekStagedAgentFix(2_000)).toBeNull();
  });

  it('drops a request the workspace never took', () => {
    stageAgentFixForWorkspace({ courseId: 'course-1', prefill: 'Fix it' }, 1_000);
    expect(peekStagedAgentFix(1_000 + AGENT_FIX_STAGED_TTL_MS + 1)).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('drops anything it cannot read as a request', () => {
    for (const raw of [
      'not json',
      JSON.stringify({ courseId: '', prefill: 'x', stagedAt: 1 }),
      JSON.stringify({ courseId: 'c', prefill: 7, stagedAt: 1 }),
      JSON.stringify({ courseId: 'c', prefill: 'x' }),
    ]) {
      window.sessionStorage.setItem(KEY, raw);
      expect(peekStagedAgentFix(2)).toBeNull();
      expect(window.sessionStorage.getItem(KEY)).toBeNull();
    }
  });

  it('numbers composer seeds uniquely for the page lifetime', () => {
    const first = nextAgentFixSeedKey();
    expect(nextAgentFixSeedKey()).toBeGreaterThan(first);
  });
});
