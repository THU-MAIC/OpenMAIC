/**
 * Forced skill loading — a `/handle` the user typed is LOADED.
 *
 * The gap these pin (see skill-preload.ts): only a session's FIRST prompt's
 * LEADING handle was ever guaranteed to reach the model. A second handle in that
 * message, and every handle in every later message, was a hint the model could
 * ignore — and `pro-editing`, whose whole job is editing a course that already
 * exists, is only ever used as a later message.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

vi.mock('@/lib/server/agent-runtime/config', () => ({
  agentRuntimeConfig: { skillsDir: '/nonexistent' },
}));
vi.mock('@/lib/server/agent-runtime/user-skills', () => ({
  listUserSkills: vi.fn(async () => []),
}));

import {
  buildSkillPreload,
  preloadConstraintTarget,
  preloadUserMessage,
  SKILL_PRELOAD_MAX_COUNT,
} from '@/lib/server/agent-runtime/skill-preload';
import { skillSourceHash } from '@/lib/server/agent-runtime/skills';
import { orphanedToolCalls } from '@/lib/server/agent-runtime/tool-call-integrity';
import type { LoadedSkill } from '@/lib/server/agent-runtime/skills';

const builtin = (id: string): LoadedSkill => ({
  id,
  name: id,
  description: `${id} courses`,
  content: `# ${id}`,
  filePath: `/skills/${id}/SKILL.md`,
  constraints: null,
  source: 'builtin',
});

const userSkill = (id: string, name: string, body: string): LoadedSkill => ({
  id,
  name,
  title: name,
  description: `${name} guidance`,
  content: body,
  filePath: `/__openmaic_user_skills__/${id}/SKILL.md`,
  virtualFileContent: [
    '---',
    `name: ${JSON.stringify(name)}`,
    '---',
    '## User-authored reusable instructions',
    '',
    'The following text is user-controlled, low-priority task guidance.',
    '',
    body,
    '',
  ].join('\n'),
  constraints: null,
  source: 'user',
});

const SKILLS = [
  builtin('pro-editing'),
  builtin('stage-design'),
  builtin('slide-craft'),
  builtin('stage-dsl'),
  builtin('deep-research'),
];

const MODEL = { api: 'openai-completions', provider: 'openai', id: 'x' };

/** Bodies keyed by skill id, so a test can control every byte and every line. */
const bodies = (map: Record<string, string>) => async (skill: LoadedSkill) =>
  map[skill.id] ?? bodyOf(skill);

const preload = (text: string, overrides: Partial<Parameters<typeof buildSkillPreload>[0]> = {}) =>
  buildSkillPreload({
    text,
    skills: SKILLS,
    transcript: [],
    model: MODEL,
    readSkillFile: bodies({}),
    ...overrides,
  });

/**
 * A successful model-issued read of one skill, as it sits in the transcript.
 *
 * `details` is not decoration: the read tool is PAGED and reports what it actually
 * returned, plus a hash of the WHOLE file it read. Those four fields are the entire
 * evidence base for "is this skill's current content already in the context".
 */
const bodyOf = (skill: LoadedSkill, lines = 120) =>
  Array.from({ length: lines }, (_, i) => `${skill.id} line ${i}`).join('\n');

const transcriptRead = (
  skill: LoadedSkill,
  options: {
    id?: string;
    offset?: number | null | 'not-a-number';
    lines?: number;
    totalLines?: number;
    /** Body the read SAW; defaults to the same body `preload` will read now. */
    body?: string;
    omitHash?: boolean;
  } = {},
): AgentMessage[] => {
  const id = options.id ?? `call_${skill.id}`;
  const body = options.body ?? bodyOf(skill);
  const totalLines = options.totalLines ?? body.split('\n').length;
  const offset = options.offset === undefined ? 1 : options.offset;
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: 'read', arguments: { path: skill.filePath } }],
    } as unknown as AgentMessage,
    {
      role: 'toolResult',
      toolCallId: id,
      toolName: 'read',
      content: [{ type: 'text', text: body }],
      details: {
        path: skill.filePath,
        ...(offset === null ? {} : { offset }),
        lines: options.lines ?? totalLines,
        totalLines,
        skill: skill.id,
        ...(options.omitHash ? {} : { sourceHash: skillSourceHash(body) }),
      },
      isError: false,
    } as unknown as AgentMessage,
  ];
};

describe('which skills get force-loaded', () => {
  it('loads EVERY handle in the message, leading one included', async () => {
    // The first-turn message. Both handles take the same path now: the leading
    // one is no longer pasted inline with no `read` behind it.
    const result = await preload('/stage-design /slide-craft build a lesson', {
      forced: [builtin('stage-design')],
    });
    expect(result.injected.map((s) => s.id)).toEqual(['stage-design', 'slide-craft']);
    expect(result.deferred).toEqual([]);
  });

  it('loads a FORCED skill the text does not name — the `?skill=` launch link', async () => {
    // `?skill=` writes the session's `skillId` from the URL; the prompt text has
    // no handle at all, so text extraction alone would silently drop it.
    const result = await preload('build a refraction lesson', {
      forced: [builtin('stage-design')],
    });
    expect(result.injected.map((s) => s.id)).toEqual(['stage-design']);
  });

  it('counts a forced skill once when the text names it too, forced first', async () => {
    const result = await preload('/slide-craft /stage-design build a lesson', {
      forced: [builtin('stage-design')],
    });
    expect(result.injected.map((s) => s.id)).toEqual(['stage-design', 'slide-craft']);
    expect(result.messages).toHaveLength(4);
  });

  it('does not reload a forced skill the transcript already carries', async () => {
    // Later runs of the same session still pass the frozen `skillId`; the
    // transcript — not a special case — is what keeps it to one load.
    const result = await preload('edit it again', {
      forced: [builtin('pro-editing')],
      transcript: transcriptRead(builtin('pro-editing')),
    });
    expect(result.injected).toEqual([]);
    expect(result.messages).toEqual([]);
  });

  it('loads a handle in a FOLLOW-UP message — the gap pro-editing lived in', async () => {
    // A later message, with a transcript behind it and no session `skillId`.
    const result = await preload('/pro-editing make the example on page three more relatable', {
      transcript: transcriptRead(builtin('stage-design')),
    });
    expect(result.injected.map((s) => s.id)).toEqual(['pro-editing']);
  });

  it('loads a handle written in the MIDDLE of the sentence', async () => {
    const result = await preload('look at this lesson first, then /pro-editing page three');
    expect(result.injected.map((s) => s.id)).toEqual(['pro-editing']);
  });

  it('loads a repeated handle exactly once', async () => {
    const result = await preload('/pro-editing page three, then /pro-editing page five');
    expect(result.injected.map((s) => s.id)).toEqual(['pro-editing']);
    expect(result.messages).toHaveLength(2);
  });

  it('does not load a skill whose body is already in the transcript', async () => {
    const result = await preload('/pro-editing edit again', {
      transcript: transcriptRead(builtin('pro-editing')),
    });
    expect(result.injected).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.text).toBe('/pro-editing edit again');
  });

  it('reloads a skill whose earlier read FAILED', async () => {
    const failed = transcriptRead(builtin('pro-editing'));
    (failed[1] as unknown as { isError: boolean }).isError = true;
    const result = await preload('/pro-editing edit page three', { transcript: failed });
    expect(result.injected.map((s) => s.id)).toEqual(['pro-editing']);
  });

  it('ignores an unknown handle and leaves the message alone', async () => {
    const result = await preload('/not-a-skill /also-not build a lesson');
    expect(result.injected).toEqual([]);
    expect(result.deferred).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.text).toBe('/not-a-skill /also-not build a lesson');
  });

  it('ignores a token that only looks like a handle', async () => {
    // A path and a bare slash are not handles — the composer paints no pill on
    // them either (`skillHandleName`).
    const result = await preload('look at /skills/pro-editing/SKILL.md and / here');
    expect(result.injected).toEqual([]);
  });

  it('does nothing for a message with no handles', async () => {
    const result = await preload('make page three more relatable');
    expect(result).toMatchObject({ injected: [], deferred: [], messages: [] });
    expect(result.text).toBe('make page three more relatable');
  });

  it('does nothing when the deployment has no skills at all', async () => {
    const result = await preload('/pro-editing edit page three', { skills: [] });
    expect(result.messages).toEqual([]);
  });
});

describe('the caps, and what happens past them', () => {
  it('stops at the count cap and DEFERS the rest by naming their location', async () => {
    const result = await preload(
      '/pro-editing /stage-design /slide-craft /stage-dsl /deep-research together',
      { maxCount: 2 },
    );
    expect(result.injected.map((s) => s.id)).toEqual(['pro-editing', 'stage-design']);
    expect(result.deferred.map((s) => s.id)).toEqual(['slide-craft', 'stage-dsl', 'deep-research']);
    // Explicit degradation: the model is told the skills exist and where.
    expect(result.text).toContain('/slide-craft');
    expect(result.text).toContain('/skills/slide-craft/SKILL.md');
    expect(result.text).toContain('read');
    // And the original message survives verbatim at the front.
    expect(result.text.startsWith('/pro-editing /stage-design')).toBe(true);
  });

  it('stops at the byte budget the same way, and reports it', async () => {
    const skipped: string[] = [];
    const result = await preload('/pro-editing /stage-design together', {
      maxBytes: 100,
      readSkillFile: bodies({ 'pro-editing': 'x'.repeat(80), 'stage-design': 'y'.repeat(80) }),
      onSkipped: (skill) => skipped.push(skill.id),
    });
    expect(result.injected.map((s) => s.id)).toEqual(['pro-editing']);
    expect(result.deferred.map((s) => s.id)).toEqual(['stage-design']);
    expect(skipped).toEqual(['stage-design']);
  });

  it('admits the FIRST named skill however large it is', async () => {
    // Otherwise `/slide-dsl` alone — 66KB in this repo — would silently do
    // nothing, which is the bug being fixed rather than a budget being kept.
    const result = await preload('/stage-dsl patch this page with the DSL', {
      maxBytes: 10,
      readSkillFile: bodies({ 'stage-dsl': 'z'.repeat(70_000) }),
    });
    expect(result.injected.map((s) => s.id)).toEqual(['stage-dsl']);
    expect(result.deferred).toEqual([]);
  });

  it('defaults to a real ceiling rather than "as many as you type"', () => {
    expect(SKILL_PRELOAD_MAX_COUNT).toBeLessThanOrEqual(3);
  });

  it('degrades instead of throwing when a skill cannot be read', async () => {
    const skipped: string[] = [];
    const result = await preload('/pro-editing /stage-design together', {
      readSkillFile: async (skill) => {
        if (skill.id === 'pro-editing') throw new Error('ENOENT');
        return '# stage-design';
      },
      onSkipped: (skill, reason) => skipped.push(`${skill.id}: ${reason}`),
    });
    expect(result.injected.map((s) => s.id)).toEqual(['stage-design']);
    expect(result.deferred.map((s) => s.id)).toEqual(['pro-editing']);
    expect(skipped[0]).toContain('ENOENT');
    expect(result.text).toContain('/skills/pro-editing/SKILL.md');
  });

  it('still names the skill when NOTHING could be loaded', async () => {
    const result = await preload('/pro-editing edit page three', {
      readSkillFile: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(result.injected).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.text).toContain('/skills/pro-editing/SKILL.md');
  });
});

describe('the shape of the delivered turn', () => {
  it('adds NO user message — the delivery cursor counts those', async () => {
    // `deliveredFollowUps()` in the runner is "how many `user` messages exist".
    // A second one here would advance it and a real user message would be
    // marked delivered and silently dropped.
    const result = await preload('/pro-editing /stage-design edit page three');
    expect(result.messages.some((m) => m.role === 'user')).toBe(false);
    const delivered = [preloadUserMessage(result.text), ...result.messages];
    expect(delivered.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(delivered[0]!.role).toBe('user');
  });

  it('is user -> assistant(toolCall) -> toolResult, in that order, per skill', async () => {
    const result = await preload('/pro-editing /stage-design edit page three');
    const delivered = [preloadUserMessage(result.text), ...result.messages];
    expect(delivered.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
      'toolResult',
    ]);
  });

  it('never leaves an orphaned toolCall, and every id is unique', async () => {
    // An orphaned toolCall wedges the session forever.
    const result = await preload('/pro-editing /stage-design /slide-craft edit page three');
    const delivered = [preloadUserMessage(result.text), ...result.messages];
    expect(orphanedToolCalls(delivered)).toEqual([]);
    const ids = result.messages.flatMap((m) =>
      m.role === 'assistant'
        ? ((m as unknown as { content: { id?: string }[] }).content ?? []).map((p) => p.id)
        : [],
    );
    expect(ids.filter(Boolean)).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    // The result for a call sits IMMEDIATELY after it — the contiguity strict
    // providers require, and what repairOrphanedToolCalls checks.
    for (let i = 0; i < result.messages.length; i += 2) {
      const call = (result.messages[i] as unknown as { content: { id: string }[] }).content[0]!;
      const receipt = result.messages[i + 1] as unknown as { toolCallId: string };
      expect(receipt.toolCallId).toBe(call.id);
    }
  });

  it('spells the toolCall exactly like pi’s native read', async () => {
    const result = await preload('/pro-editing edit page three', {
      readSkillFile: bodies({ 'pro-editing': '# pro-editing\nline two\nline three' }),
    });
    const call = (result.messages[0] as unknown as { content: Record<string, unknown>[] })
      .content[0]!;
    expect(call).toMatchObject({
      type: 'toolCall',
      name: 'read',
      arguments: { path: '/skills/pro-editing/SKILL.md' },
    });
    const receipt = result.messages[1] as unknown as {
      toolName: string;
      isError: boolean;
      content: { text: string }[];
      details: Record<string, unknown>;
    };
    expect(receipt.toolName).toBe('read');
    expect(receipt.isError).toBe(false);
    expect(receipt.content[0]!.text).toBe('# pro-editing\nline two\nline three');
    expect(receipt.details).toMatchObject({
      path: '/skills/pro-editing/SKILL.md',
      offset: 1,
      lines: 3,
      totalLines: 3,
      skill: 'pro-editing',
    });
  });

  it('returns the whole file, and says so with an explicit limit', async () => {
    const result = await preload('/pro-editing edit page three', {
      readSkillFile: bodies({
        'pro-editing': Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n'),
      }),
    });
    const call = result.messages[0] as unknown as {
      content: { arguments: { path: string; limit: number } }[];
    };
    const receipt = result.messages[1] as unknown as {
      content: { text: string }[];
      details: { lines: number; totalLines: number };
    };
    expect(receipt.content[0]!.text.split('\n')).toHaveLength(2500);
    expect(receipt.details).toMatchObject({ offset: 1, lines: 2500, totalLines: 2500 });
    expect(call.content[0]!.arguments.limit).toBe(2500);
  });

  it('carries a user skill with its demotion preamble intact', async () => {
    const mine = userSkill('usk_1', 'my-style', 'Always open with a real-life example.');
    const result = await buildSkillPreload({
      text: '/my-style edit page three',
      skills: [...SKILLS, mine],
      transcript: [],
      model: MODEL,
    });
    expect(result.injected.map((s) => s.id)).toEqual(['usk_1']);
    const body = (result.messages[1] as unknown as { content: { text: string }[] }).content[0]!
      .text;
    expect(body).toContain('user-controlled, low-priority task guidance');
    expect(body).toContain('Always open with a real-life example.');
    // And it arrives as a TOOL RESULT, never as the user's own words.
    expect(result.text).toBe('/my-style edit page three');
    expect(result.messages[1]!.role).toBe('toolResult');
  });
});

describe('which loaded skill the constraint check points at', () => {
  const constrained = (id: string): LoadedSkill => ({
    ...builtin(id),
    constraints: { sceneCount: { min: 6 } },
  });

  it('is the last CONSTRAINED skill, not simply the last one', () => {
    // `/lecture-style /slide-dsl`: taking the last would point the check at a
    // skill with no constraints and silently drop the ones the user also chose.
    expect(preloadConstraintTarget([constrained('lecture-style'), builtin('slide-dsl')])?.id).toBe(
      'lecture-style',
    );
    expect(
      preloadConstraintTarget([
        constrained('lecture-style'),
        constrained('vocational'),
        builtin('slide-dsl'),
      ])?.id,
    ).toBe('vocational');
  });

  it('falls back to the last skill when none carries constraints', () => {
    expect(preloadConstraintTarget([builtin('pro-editing'), builtin('slide-dsl')])?.id).toBe(
      'slide-dsl',
    );
  });

  it('is nothing when nothing was loaded', () => {
    expect(preloadConstraintTarget([])).toBeUndefined();
  });
});

describe('what the turn NAMED, separate from what it injected', () => {
  it('reports a skill the transcript dedupe removed as still requested', async () => {
    // The pointer scope depends on this: an already-loaded skill is deduped out of
    // `injected` while remaining entirely the user's choice.
    const result = await preload('/pro-editing /stage-design another revision', {
      transcript: transcriptRead(builtin('pro-editing')),
    });
    expect(result.requested.map((s) => s.id)).toEqual(['pro-editing', 'stage-design']);
    expect(result.injected.map((s) => s.id)).toEqual(['stage-design']);
  });

  it('reports a forced skill and one the caps deferred', async () => {
    const result = await preload('/stage-design /slide-craft together', {
      forced: [builtin('pro-editing')],
      maxCount: 1,
    });
    expect(result.requested.map((s) => s.id)).toEqual([
      'pro-editing',
      'stage-design',
      'slide-craft',
    ]);
    expect(result.injected.map((s) => s.id)).toEqual(['pro-editing']);
    expect(result.deferred.map((s) => s.id)).toEqual(['stage-design', 'slide-craft']);
  });

  it('reports nothing named when every skill is already loaded', async () => {
    const result = await preload('/pro-editing edit again', {
      transcript: transcriptRead(builtin('pro-editing')),
    });
    expect(result.requested.map((s) => s.id)).toEqual(['pro-editing']);
    expect(result.injected).toEqual([]);
  });

  it('is empty when the turn names no installed skill', async () => {
    expect((await preload('/nope build a lesson')).requested).toEqual([]);
    expect((await preload('just edit something')).requested).toEqual([]);
  });
});

/**
 * The read tool is PAGED, so "the transcript contains a successful read of this
 * path" is not the same claim as "the model has this skill's instructions".
 *
 * One `offset: 2` read used to mark a whole SKILL.md as loaded, after which the
 * user's own explicit `/handle` was deduped away — most of the body never reaching
 * the model at all, and the guardrail reporting nothing wrong.
 *
 * ── The coverage table ───────────────────────────────────────────────────────
 *
 * "Is this skill already loaded" has THREE conditions and every one of them was
 * put there by a defect. One `if` at a time is how this block produced three
 * findings in a row, so the judges below are the table, exhaustively:
 *
 *  1. `offset` present, a number, === 1   — a late start is not the file, and a
 *                                            MISSING offset proves nothing
 *  2. `lines` >= `totalLines`, both numbers — a paged window is not the file
 *  3. `sourceHash` === the file's hash NOW — the record describes the file as it
 *                                            WAS; an edited skill is a new file
 *
 * Direction is fixed: unprovable means NOT loaded. Every "missing field" row
 * re-pastes a body the model may already hold; the opposite error silently
 * withholds instructions the user explicitly asked for.
 */
describe('the coverage table: what counts as already loaded', () => {
  const injected = async (transcript: AgentMessage[]) =>
    (await preload('/pro-editing edit page three', { transcript })).injected.map((s) => s.id);

  it('COVERED: offset 1, whole file, hash matches the file now', async () => {
    expect(await injected(transcriptRead(builtin('pro-editing')))).toEqual([]);
  });

  describe('condition 1 — the read must be PROVEN to start at line 1', () => {
    it('rejects a read that started late', async () => {
      expect(
        await injected(transcriptRead(builtin('pro-editing'), { offset: 40, lines: 20 })),
      ).toEqual(['pro-editing']);
    });

    it('rejects a window as long as the file that did not START at line 1', async () => {
      // The line count alone would call this a load; it is a 120-line window of a
      // 120-line file taken from line 40, which is not the file.
      expect(
        await injected(
          transcriptRead(builtin('pro-editing'), { offset: 40, lines: 120, totalLines: 120 }),
        ),
      ).toEqual(['pro-editing']);
    });

    it('rejects a MISSING offset instead of defaulting it to 1', async () => {
      // The default was the bug: the question is whether coverage can be PROVEN.
      expect(await injected(transcriptRead(builtin('pro-editing'), { offset: null }))).toEqual([
        'pro-editing',
      ]);
    });

    it('rejects a non-numeric offset', async () => {
      expect(
        await injected(transcriptRead(builtin('pro-editing'), { offset: 'not-a-number' })),
      ).toEqual(['pro-editing']);
    });
  });

  describe('condition 2 — the window must reach the end of the file', () => {
    it('rejects a read cut off by a line limit', async () => {
      expect(
        await injected(transcriptRead(builtin('pro-editing'), { lines: 50, totalLines: 600 })),
      ).toEqual(['pro-editing']);
    });

    it('rejects a result whose line numbers are missing', async () => {
      const legacy = transcriptRead(builtin('pro-editing'));
      delete (legacy[1] as unknown as { details: { lines?: unknown } }).details.lines;
      expect(await injected(legacy)).toEqual(['pro-editing']);
    });

    it('rejects a result with no details at all', async () => {
      const legacy = transcriptRead(builtin('pro-editing'));
      delete (legacy[1] as unknown as { details?: unknown }).details;
      expect(await injected(legacy)).toEqual(['pro-editing']);
    });
  });

  describe('condition 3 — the record must describe the file as it is NOW', () => {
    it('re-injects a skill that grew after the read', async () => {
      // The real cases: a builtin edited in a release, a user skill rewritten
      // through `patch_skill`. The old read covered 120 lines of a
      // 120-line file — and that file has 700 lines now, so its new instructions
      // have never been in the context.
      const before = bodyOf(builtin('pro-editing'), 120);
      const after = bodyOf(builtin('pro-editing'), 700);
      const result = await preload('/pro-editing edit page three', {
        transcript: transcriptRead(builtin('pro-editing'), { body: before }),
        readSkillFile: bodies({ 'pro-editing': after }),
      });
      expect(result.injected.map((s) => s.id)).toEqual(['pro-editing']);
      // And what gets pasted is the NEW content.
      const pasted = (result.messages[1] as unknown as { content: { text: string }[] }).content[0]!
        .text;
      expect(pasted).toContain('pro-editing line 699');
    });

    it('re-injects a skill edited WITHOUT changing its line count', async () => {
      // Why the identity is a hash and not a line count or a length: an edit that
      // rewrites a line in place is the ordinary shape of an edit, and a
      // count-based check would call the file unchanged.
      const before = bodyOf(builtin('pro-editing'), 120);
      const after = `${before.split('\n').slice(0, -1).join('\n')}\nAND ALWAYS CITE A SOURCE.`;
      expect(before.split('\n').length).toBe(after.split('\n').length);
      expect(await injected2('/pro-editing edit page three', before, after)).toEqual([
        'pro-editing',
      ]);
    });

    it('does NOT re-inject an unchanged skill — the rule is not "never dedupe"', async () => {
      const same = bodyOf(builtin('pro-editing'), 120);
      expect(await injected2('/pro-editing edit page three', same, same)).toEqual([]);
    });

    it('rejects a record with no hash at all', async () => {
      expect(await injected(transcriptRead(builtin('pro-editing'), { omitHash: true }))).toEqual([
        'pro-editing',
      ]);
    });
  });

  /** Read the skill as `before`, then ask with the file actually being `after`. */
  async function injected2(text: string, before: string, after: string) {
    const result = await preload(text, {
      transcript: transcriptRead(builtin('pro-editing'), { body: before }),
      readSkillFile: bodies({ 'pro-editing': after }),
    });
    return result.injected.map((s) => s.id);
  }

  it('keeps the ACTIVE-skill pointer on a partial read — a different question', async () => {
    // "Which skill is this conversation planned under" is answered by opening the
    // file at all; only "is the whole current body in context" needs the table.
    const { skillReadFromTranscript, skillReadRecordsInTranscript, readProvesCoverage } =
      await import('@/lib/server/agent-runtime/skills');
    const partial = transcriptRead(builtin('pro-editing'), { offset: 40, lines: 20 });
    expect(skillReadFromTranscript(partial, SKILLS)?.id).toBe('pro-editing');
    const records = skillReadRecordsInTranscript(partial, SKILLS).get('pro-editing') ?? [];
    expect(records).toHaveLength(1);
    expect(readProvesCoverage(records[0]!, skillSourceHash(bodyOf(builtin('pro-editing'))))).toBe(
      false,
    );
  });
});

/**
 * A skill longer than pi's default read page.
 *
 * The preload used to take that default 2000-line slice, so that a synthesized
 * read could never be MORE of the file than a model-issued one. The consequence
 * was a permanently half-loaded skill: the record says `lines < totalLines`, so
 * `readProvesCoverage` refuses it — correctly — and the NEXT turn injects the
 * very same head again. The tail never arrived and every turn paid for the head.
 *
 * No shipped builtin is that long (`slide-dsl`, the largest, is 892 lines), but a
 * user skill is capped in BYTES: 64KiB of short lines is thousands of them.
 */
describe('a skill longer than the default read page', () => {
  const LONG_LINES = 2600;
  const long = Array.from({ length: LONG_LINES }, (_, i) => `pro-editing line ${i}`).join('\n');
  const withLong = { readSkillFile: bodies({ 'pro-editing': long }) };

  const receiptOf = (messages: readonly AgentMessage[]) => {
    const receipt = messages.find((message) => message.role === 'toolResult');
    if (!receipt) throw new Error('no toolResult in the preload');
    return receipt as unknown as {
      content: { text: string }[];
      details: { lines: number; totalLines: number };
    };
  };

  it('injects the whole file, tail included', async () => {
    const receipt = receiptOf((await preload('/pro-editing edit it', withLong)).messages);

    expect(receipt.content[0]!.text).toContain(`pro-editing line ${LONG_LINES - 1}`);
    expect(receipt.details.lines).toBe(LONG_LINES);
    expect(receipt.details.totalLines).toBe(LONG_LINES);
  });

  it('leaves a record that PROVES coverage, so the next turn does not re-inject the head', async () => {
    const first = await preload('/pro-editing edit it', withLong);

    const second = await preload('/pro-editing edit another spot', {
      ...withLong,
      transcript: first.messages,
    });

    expect(second.injected).toEqual([]);
    expect(second.messages).toEqual([]);
  });
});
