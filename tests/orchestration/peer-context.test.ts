import { describe, expect, test } from 'vitest';
import { buildPeerContextSection } from '@/lib/orchestration/summarizers/peer-context';
import type { AgentTurnSummary } from '@/lib/orchestration/types';

// ==================== Helpers ====================

const summary = (agentName: string, preview: string): AgentTurnSummary => ({
  agentId: agentName.toLowerCase().replace(/\s/g, '-'),
  agentName,
  contentPreview: preview,
  actionCount: 0,
  whiteboardActions: [],
});

// ==================== Tests ====================

describe('buildPeerContextSection — basic behavior', () => {
  test('returns empty string when no agent responses exist', () => {
    expect(buildPeerContextSection(undefined, 'Teacher')).toBe('');
    expect(buildPeerContextSection([], 'Teacher')).toBe('');
  });

  test('filters out the current agent from peer list', () => {
    const responses = [
      summary('Teacher', 'Axial symmetry means...'),
      summary('Xiao Ming', 'I agree!'),
    ];
    const out = buildPeerContextSection(responses, 'Teacher');
    expect(out).not.toContain('Teacher:');
    expect(out).toContain('Xiao Ming');
  });

  test('returns empty string when only self in responses', () => {
    const responses = [summary('Teacher', 'I already spoke.')];
    const out = buildPeerContextSection(responses, 'Teacher');
    expect(out).toBe('');
  });

  test('lists all peers that are not the current agent', () => {
    const responses = [
      summary('Teacher', 'Here is the concept.'),
      summary('Xiao Ming', 'I understand!'),
      summary('Li Hua', 'Me too!'),
    ];
    const out = buildPeerContextSection(responses, 'Teacher');
    expect(out).toContain('Xiao Ming');
    expect(out).toContain('Li Hua');
    expect(out).not.toContain('Teacher:');
  });
});

describe('buildPeerContextSection — message attribution note (issue #511 fix)', () => {
  test('includes message attribution note distinguishing peer vs human messages', () => {
    const responses = [summary('Xiao Ming', 'I think the gate is symmetric!')];
    const out = buildPeerContextSection(responses, 'Teacher');

    // The fix: agents must know that [AgentName]: prefixed messages in history
    // are from AI peers, not from the human student
    expect(out).toContain('Message Attribution');
    expect(out).toContain('[AgentName]:');
    expect(out).toContain('human student');
  });

  test('attribution note is present regardless of how many peers have spoken', () => {
    const responses = [
      summary('Xiao Ming', 'Symmetric!'),
      summary('Li Hua', 'Agreed!'),
    ];
    const out = buildPeerContextSection(responses, 'Teacher');
    expect(out).toContain('Message Attribution');
  });
});
