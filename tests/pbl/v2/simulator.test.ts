import { describe, expect, it } from 'vitest';

import {
  buildSimulatorSystemPrompt,
  buildNarratorSystemPrompt,
  buildSimulatorHistory,
  isFirstSceneEntry,
} from '@/lib/pbl/v2/agents/simulator';
import type { PBLChatMessage, PBLAgentThread } from '@/lib/pbl/v2/types';
import { normalizeProjectRuntime, PBL_SIMULATOR_AGENT_ID } from '@/lib/pbl/v2/operations/progress';
import type { PBLProjectV2, PBLMilestone, PBLMicrotask } from '@/lib/pbl/v2/types';

function roleplayMilestone(): PBLMilestone {
  return {
    id: 'ms-rp',
    title: '和林夏聊一聊',
    status: 'active',
    order: 1,
    documents: [],
    scenarioStage: 'roleplay',
    briefing: '你坐在咖啡馆里，林夏刚到。',
    microtasks: [
      {
        id: 'beat-1',
        title: 'beat',
        status: 'in_progress',
        assignee: 'user',
        hints: [],
        order: 0,
        description: '林夏坐在你对面，刚点了一杯热可可，眼睛有点红。',
        completionCriteria: '学习者确认了林夏的情绪',
        narration: '你们走进了一家安静的咖啡馆。',
      } as unknown as PBLMicrotask,
    ],
  } as unknown as PBLMilestone;
}

function scenarioProject(): PBLProjectV2 {
  return {
    language: 'zh-CN',
    roles: [{ id: 'role-i', type: 'instructor', name: '教练' }],
    threads: [{ agentId: 'role-i', messages: [] }],
    updatedAt: '2026-06-07T00:00:00.000Z',
    scenario: {
      setting: '校园咖啡馆的午后',
      goal: '练习倾听与共情',
      rules: '保持真诚，不评判',
      learnerRole: '你是林夏的好朋友',
      characters: [
        {
          id: 'c1',
          name: '林夏',
          persona: '内向，说话轻声细语',
          situation: '这周失恋，情绪低落',
          boundaries: '不会突然崩溃大哭',
        },
      ],
    },
    milestones: [
      {
        id: 'ms-prep',
        title: '准备',
        status: 'completed',
        order: 0,
        documents: [],
        scenarioStage: 'prep',
        microtasks: [],
      },
      roleplayMilestone(),
      {
        id: 'ms-wrap',
        title: '收尾',
        status: 'locked',
        order: 2,
        documents: [],
        scenarioStage: 'wrapup',
        microtasks: [],
      },
    ],
    evaluations: [],
    engagementEvents: [],
  } as unknown as PBLProjectV2;
}

function plainProject(): PBLProjectV2 {
  return {
    roles: [{ id: 'role-i', type: 'instructor', name: 'Instructor' }],
    threads: [{ agentId: 'role-i', messages: [] }],
    updatedAt: '2026-06-07T00:00:00.000Z',
    milestones: [
      {
        id: 'ms-1',
        title: 'M1',
        status: 'active',
        order: 0,
        documents: [],
        microtasks: [
          { id: 'mt-1', title: 'T1', status: 'in_progress', assignee: 'user', hints: [], order: 0 },
        ],
      },
    ],
    evaluations: [],
    engagementEvents: [],
  } as unknown as PBLProjectV2;
}

describe('PBL v2 — Simulator thread normalization (increment 3)', () => {
  it('creates a Simulator thread for a scenario project', () => {
    const p = scenarioProject();
    expect(p.threads.some((t) => t.agentId === PBL_SIMULATOR_AGENT_ID)).toBe(false);
    const changed = normalizeProjectRuntime(p);
    expect(changed).toBe(true);
    expect(p.threads.some((t) => t.agentId === PBL_SIMULATOR_AGENT_ID)).toBe(true);
  });

  it('is idempotent — does not duplicate the Simulator thread', () => {
    const p = scenarioProject();
    normalizeProjectRuntime(p);
    normalizeProjectRuntime(p);
    expect(p.threads.filter((t) => t.agentId === PBL_SIMULATOR_AGENT_ID)).toHaveLength(1);
  });

  it('NEVER creates a Simulator thread for an ordinary (non-scenario) project', () => {
    const p = plainProject();
    normalizeProjectRuntime(p);
    expect(p.threads.some((t) => t.agentId === PBL_SIMULATOR_AGENT_ID)).toBe(false);
  });
});

describe('PBL v2 — Simulator system prompt (increment 3)', () => {
  it('injects the concrete scene + cast (persona/situation/boundaries) and the project language', () => {
    const p = scenarioProject();
    const ms = p.milestones.find((m) => m.scenarioStage === 'roleplay')!;
    const prompt = buildSimulatorSystemPrompt(p, ms, ms.microtasks[0]);
    expect(prompt).toContain('校园咖啡馆的午后');
    expect(prompt).toContain('林夏');
    expect(prompt).toContain('这周失恋，情绪低落');
    expect(prompt).toContain('保持真诚，不评判'); // rules
    expect(prompt).toContain('你是林夏的好朋友'); // learnerRole
    expect(prompt).toContain('和林夏聊一聊'); // current scene title
    expect(prompt).toContain('zh-CN'); // language lock
  });

  it('carries zero teaching rules + forbids narrating/evaluating/guiding — it is a character, not a coach/narrator', () => {
    const p = scenarioProject();
    const ms = p.milestones.find((m) => m.scenarioStage === 'roleplay')!;
    const prompt = buildSimulatorSystemPrompt(p, ms, ms.microtasks[0]);
    expect(prompt).toMatch(/NOT the narrator, a coach, a teacher, an examiner, or a judge/i);
    expect(prompt).toMatch(/Evaluate, praise, grade/i); // no judging the learner
    expect(prompt).toMatch(/Ask the learner to explain, justify/i); // no quizzing reasoning
    expect(prompt).toMatch(/participant/i); // pursues its own goals, not a facilitator
    expect(prompt).toMatch(/never.*AI/i);
  });

  it('does NOT feed the beat completionCriteria (the pedagogical goal) into the character — that is what turned it into a coach', () => {
    const p = scenarioProject();
    const ms = p.milestones.find((m) => m.scenarioStage === 'roleplay')!;
    const prompt = buildSimulatorSystemPrompt(p, ms, ms.microtasks[0]);
    expect(prompt).not.toMatch(/Private direction/i);
    expect(prompt).not.toContain('学习者确认了林夏的情绪'); // completionCriteria must stay out of the character's mouth-prompt
  });

  it('grounds the character in the beat established facts (narration + description) so it cannot invent/contradict', () => {
    const p = scenarioProject();
    const ms = p.milestones.find((m) => m.scenarioStage === 'roleplay')!;
    const prompt = buildSimulatorSystemPrompt(p, ms, ms.microtasks[0]);
    expect(prompt).toMatch(/Established facts/i);
    expect(prompt).toContain('林夏坐在你对面，刚点了一杯热可可'); // from description
    expect(prompt).toMatch(/never invent or contradict/i);
  });

  it('B1′: injects the beat characterObjective as a PRIVATE aim (never narrated/coached) when authored', () => {
    const p = scenarioProject();
    const ms = p.milestones.find((m) => m.scenarioStage === 'roleplay')!;
    (ms.microtasks[0] as unknown as PBLMicrotask).characterObjective = '想知道你是否真的在乎';
    const prompt = buildSimulatorSystemPrompt(p, ms, ms.microtasks[0]);
    expect(prompt).toContain('想知道你是否真的在乎');
    expect(prompt).toMatch(/private aim/i);
    expect(prompt).toMatch(/NEVER announce it, narrate it, evaluate/i);
  });

  it('B1′: omits the private-aim block entirely when the beat has no characterObjective', () => {
    const p = scenarioProject();
    const ms = p.milestones.find((m) => m.scenarioStage === 'roleplay')!;
    const prompt = buildSimulatorSystemPrompt(p, ms, ms.microtasks[0]);
    expect(prompt).not.toMatch(/private aim this beat/i);
  });
});

describe('PBL v2 — Scene narrator system prompt (increment 3 — live narration)', () => {
  it('is a pure third-person narrator: not a character, not a coach, with a NONE sentinel', () => {
    const p = scenarioProject();
    const ms = p.milestones.find((m) => m.scenarioStage === 'roleplay')!;
    const prompt = buildNarratorSystemPrompt(p, ms, ms.microtasks[0]);
    expect(prompt).toMatch(/Scene Narrator/i);
    expect(prompt).toMatch(/NOT a character and NOT a coach/i);
    expect(prompt).toMatch(/never put a character's WORDS in their mouth/i);
    expect(prompt).toContain('NONE'); // silent-when-nothing-happens sentinel
  });

  it('is grounded in the scene + beat facts and bounded (no skipping ahead)', () => {
    const p = scenarioProject();
    const ms = p.milestones.find((m) => m.scenarioStage === 'roleplay')!;
    const prompt = buildNarratorSystemPrompt(p, ms, ms.microtasks[0]);
    expect(prompt).toContain('校园咖啡馆的午后'); // setting
    expect(prompt).toContain('林夏坐在你对面，刚点了一杯热可可'); // established facts (description)
    expect(prompt).toContain('林夏'); // cast name for reference
    expect(prompt).toMatch(/NEVER skip ahead/i);
  });

  it('lets the narrator describe characters’ non-verbal actions/reactions but NEVER voice/summarize their speech (the fix for the narrator eating the character’s words)', () => {
    const p = scenarioProject();
    const ms = p.milestones.find((m) => m.scenarioStage === 'roleplay')!;
    const prompt = buildNarratorSystemPrompt(p, ms, ms.microtasks[0]);
    // actions / reactions / body language ARE the narrator's job
    expect(prompt).toMatch(/NON-VERBAL behaviour/i);
    expect(prompt).toMatch(/我皱了皱眉/); // the example: a character cannot self-narrate this
    // but it must never voice OR paraphrase what a character SAYS
    expect(prompt).toMatch(/never summarize or paraphrase WHAT THEY SAY/i);
    expect(prompt).toMatch(/their own turn/i);
    // the dynamic cast line repeats the precise boundary with the actual names
    expect(prompt).toMatch(/MAY describe their visible actions, reactions/i);
    expect(prompt).toMatch(/NEVER speak for them or summarize\/paraphrase what they SAY/i);
  });

  it('returns just the base prompt for a non-scenario project (defensive)', () => {
    const plain = plainProject();
    const ms = plain.milestones[0];
    const prompt = buildNarratorSystemPrompt(plain, ms, ms.microtasks[0]);
    expect(prompt).toMatch(/Scene Narrator/i);
    expect(prompt).not.toContain('## The scene');
  });
});

describe('PBL v2 — buildSimulatorHistory audience split (role-bleed root-cause fix)', () => {
  const thread = (): PBLAgentThread =>
    ({
      agentId: PBL_SIMULATOR_AGENT_ID,
      messages: [
        { id: 's1', roleType: 'system', content: '她皱了皱眉，身体往后靠了靠。', ts: 't' },
        { id: 'c1', roleType: 'simulator', content: '你这话什么意思？', ts: 't' },
        { id: 'u1', roleType: 'user', content: '我只是关心你。', ts: 't' },
      ],
    }) as unknown as PBLAgentThread;

  it('EXCLUDES system narration from the CHARACTER history (so it cannot imitate the 3rd-person prose — the root cause)', () => {
    const out = buildSimulatorHistory(thread(), 'character');
    expect(out).toEqual([
      { role: 'assistant', content: '你这话什么意思？' },
      { role: 'user', content: '我只是关心你。' },
    ]);
    expect(JSON.stringify(out)).not.toContain('她皱了皱眉');
  });

  it('INCLUDES system narration (as Scene context) in the DIRECTOR history so scene-keeping stays continuous', () => {
    const out = buildSimulatorHistory(thread(), 'director');
    expect(out).toContainEqual({
      role: 'system',
      content: '(Scene: 她皱了皱眉，身体往后靠了靠。)',
    });
    expect(out).toContainEqual({ role: 'assistant', content: '你这话什么意思？' });
    expect(out).toContainEqual({ role: 'user', content: '我只是关心你。' });
  });

  it('returns empty for an undefined thread (both audiences)', () => {
    expect(buildSimulatorHistory(undefined, 'character')).toEqual([]);
    expect(buildSimulatorHistory(undefined, 'director')).toEqual([]);
  });
});

describe('PBL v2 — character prompt forbids 3rd-person / narration imitation', () => {
  it('explicitly bans writing in 3rd person about itself and imitating the narrator prose in history', () => {
    const p = scenarioProject();
    const ms = p.milestones.find((m) => m.scenarioStage === 'roleplay')!;
    const prompt = buildSimulatorSystemPrompt(p, ms, ms.microtasks[0]);
    expect(prompt).toMatch(/NEVER write in the third person about yourself/i);
    expect(prompt).toMatch(/NOT your style and you must NOT copy it/i);
  });
});

describe('PBL v2 — director-narrator is pure narration (act model: no advance role)', () => {
  it('narrator prompt no longer carries any beat-advance tool/role (the act model removed it)', () => {
    const p = scenarioProject();
    const ms = p.milestones.find((m) => m.scenarioStage === 'roleplay')!;
    const prompt = buildNarratorSystemPrompt(p, ms, ms.microtasks[0]);
    // The act model: the learner ends an act manually; the narrator only narrates.
    expect(prompt).not.toMatch(/advance_scene_beat/);
    expect(prompt).not.toMatch(/Behind the scenes/i);
    // It still runs after the character and stays a pure third-person narrator.
    expect(prompt).toMatch(/AFTER the character has spoken/i);
    expect(prompt).toMatch(/NOT a character and NOT a coach/i);
  });
});

describe('PBL v2 — isFirstSceneEntry (inc4d openingLine gate)', () => {
  const msg = (roleType: PBLChatMessage['roleType'], content = 'x'): PBLChatMessage => ({
    id: `m-${Math.random().toString(16).slice(2)}`,
    roleType,
    content,
    ts: 't',
  });

  it('is true for a truly empty thread', () => {
    expect(isFirstSceneEntry([])).toBe(true);
    expect(isFirstSceneEntry(undefined)).toBe(true);
  });

  it('stays true when only a system divider is present (prep→roleplay handover)', () => {
    // The handover pushes a `system` divider into the simulator thread BEFORE
    // the greeting runs — the authored openingLine must STILL be delivered.
    expect(isFirstSceneEntry([msg('system', '[MILESTONE_DIVIDER]阶段推进：准备 → 第一幕')])).toBe(
      true,
    );
  });

  it('is false once the scene has actually started (a character or learner spoke)', () => {
    expect(isFirstSceneEntry([msg('system'), msg('simulator')])).toBe(false);
    expect(isFirstSceneEntry([msg('system'), msg('user')])).toBe(false);
  });
});
