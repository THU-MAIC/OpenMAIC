/**
 * PBL v2 — Planner schema-level tests.
 *
 * Full agentic-loop tests (mocking the LLM via `MockLanguageModelV3`)
 * are deferred to PR 5 so they can be written alongside the Instructor
 * force-advance / closing-check tests, which already need that same
 * machinery. PR 2 covers what we can test *without* the LLM:
 *
 *   1. Public API surface (the names the rest of the codebase imports)
 *   2. Error-path guarantees (missing `pblConfig` → `PlannerV2Error`,
 *      not a silent corrupt project)
 *   3. The `legacyStubFromV2` helper output shape (so the generated
 *      v1 `projectConfig` stub stays valid against
 *      `PBLProjectConfig` even after v2 schema changes)
 */
import { describe, it, expect } from 'vitest';
import {
  generatePBLV2Project,
  PlannerV2Error,
  plannerCompletionGaps,
  plannerStepHasAcceptedCompletion,
  normalizeSynthesisChecks,
  buildScenarioDesignBlock,
  MAX_SYNTHESIS_STAGES,
  type PlannerV2Callbacks,
  type PlannerV2ProgressEvent,
} from '@/lib/pbl/v2/agents/planner';
import type { StepResult, ToolSet } from 'ai';

describe('PBL v2 — scenario design block (free-first dialogue)', () => {
  const pblConfig = {
    projectTopic: '恋爱沟通',
    projectDescription: '练习',
    targetSkills: ['倾听'],
  };

  it('returns empty for non-roleplay outlines (ordinary PBL prompt unchanged)', () => {
    expect(buildScenarioDesignBlock(pblConfig, false)).toBe('');
  });

  it('defaults scene beats to free dialogue (no scripted options)', () => {
    const block = buildScenarioDesignBlock(pblConfig, true);
    expect(block).toMatch(/FREE-FIRST/);
    expect(block).toMatch(/the learner always (speaks\/types|types) their OWN response/i);
  });

  it('routes hidden analysis to characterObjective / hints, never into the scene', () => {
    const block = buildScenarioDesignBlock(pblConfig, true);
    // hints guide thinking, never hand over a copy-paste line
    expect(block).toMatch(/`hints`/);
    expect(block).toMatch(/NEVER spoken by the character/i);
  });

  it('forbids authoring the roleplay character as a coach and routes out-of-scene info to its own channels', () => {
    const block = buildScenarioDesignBlock(pblConfig, true);
    expect(block).toMatch(/pure in-world participant, NEVER a coach/i);
    expect(block).toMatch(/Out-of-scene content has its own channels/i);
    expect(block).toMatch(/`narration`/);
    expect(block).toMatch(/`hints`/);
  });

  it('forbids spoilers: learner-visible text must not reveal what a beat is meant to make them discover; hidden facts go in characterObjective', () => {
    const block = buildScenarioDesignBlock(pblConfig, true);
    // The general anti-spoiler rule must be present...
    expect(block).toMatch(/No spoilers/i);
    expect(block).toMatch(/learner can see up front/i);
    expect(block).toMatch(/MUST NOT appear in any learner-visible field/i);
    // ...and route the to-be-discovered fact to the private per-beat channel.
    expect(block).toMatch(/Put it ONLY in that beat's private `characterObjective`/);
    // situation is explicitly flagged as learner-visible (briefing) → no spoilers
    expect(block).toMatch(/always-visible scenario briefing/i);
    // characterObjective is documented as the home for what the learner uncovers
    expect(block).toMatch(/fact the learner is meant to UNCOVER this beat/i);
  });

  it('directs the Planner to author ONE project-wide scene visual from all roleplay stages', () => {
    const block = buildScenarioDesignBlock(pblConfig, true);
    expect(block).toMatch(/set_scene_visual/);
    expect(block).toMatch(/project-wide scene visual/i);
    expect(block).toMatch(/motifs/);
    // it must be derived from the actual stages, not a guessed category
    expect(block).toMatch(/specific to THIS project/i);
  });

  it('B1′: requires an observable successWhen ("deliverable") per beat + drama arc + skill/motivation tags', () => {
    const block = buildScenarioDesignBlock(pblConfig, true);
    // observable success condition is the scenario "deliverable" that gates advance
    expect(block).toMatch(/`successWhen`/);
    expect(block).toMatch(/REQUIRED for every roleplay beat/i);
    expect(block).toMatch(/off-topic \/ small-talk turns from advancing/i);
    // beats are a dramatic arc of meaningful decisions, not flat filler
    expect(block).toMatch(/DRAMATIC ARC/i);
    expect(block).toMatch(/MEANINGFUL decision\/action unit/i);
    // per-beat motivation + skill tags
    expect(block).toMatch(/`characterObjective`/);
    expect(block).toMatch(/`skillFocus`/);
  });
});
import type { SceneOutline } from '@/lib/types/generation';
import type { PBLMilestone } from '@/lib/pbl/v2/types';
import type { PBLPlannerV2Input, PBLProjectV2 } from '@/lib/pbl/v2/types';

// A minimal outline that mimics what the OpenMAIC outline-generator
// produces for a PBL scene. Only fields the Planner reads are filled
// in — `pblConfig` is the contract surface.
function pblOutline(overrides?: Partial<SceneOutline>): SceneOutline {
  return {
    id: 'outline-pbl-1',
    type: 'pbl',
    title: 'CSV Data Analyzer',
    description: 'Build a small CSV → chart → report tool.',
    keyPoints: ['DataFrame', 'File IO', 'Visualization'],
    teachingObjective: 'Get comfortable with end-to-end data analysis.',
    order: 1,
    pblConfig: {
      projectTopic: 'CSV Data Analyzer',
      projectDescription: 'Build a small CSV → chart → report tool.',
      targetSkills: ['DataFrame', 'File IO', 'Visualization'],
      issueCount: 3,
    },
    ...overrides,
  };
}

function plannerInput(overrides?: Partial<PBLPlannerV2Input>): PBLPlannerV2Input {
  const outline = pblOutline();
  return {
    outline,
    courseContext: {
      allOutlines: [outline],
      languageDirective: 'Reply in English.',
    },
    ...overrides,
  };
}

function minimalPlannerProject(overrides?: Partial<PBLProjectV2>): PBLProjectV2 {
  return {
    uiPhase: 'hero',
    title: 'CSV Data Analyzer',
    description: 'Build a small CSV analyzer.',
    learningObjective: 'Practice file IO and simple charting.',
    proficiency: 'beginner',
    language: 'en-US',
    tags: [],
    status: 'designing',
    roles: [
      {
        id: 'role-instructor',
        type: 'instructor',
        name: 'Instructor',
      },
    ],
    milestones: [
      {
        id: 'milestone-1',
        title: 'Load CSV data',
        status: 'locked',
        order: 0,
        microtasks: [
          {
            id: 'microtask-1',
            title: 'Pick a CSV sample',
            status: 'todo',
            assignee: 'user',
            hints: [],
            order: 0,
          },
        ],
        documents: [],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: '2026-05-25T08:00:00.000Z',
    updatedAt: '2026-05-25T08:00:00.000Z',
    ...overrides,
  };
}

describe('PBL v2 Planner — public API surface', () => {
  it('exports the entry point and error class', () => {
    expect(typeof generatePBLV2Project).toBe('function');
    expect(PlannerV2Error.prototype).toBeInstanceOf(Error);
  });

  it('PlannerV2Error carries a `partial` project for graceful fallback', () => {
    const err = new PlannerV2Error('test', {
      uiPhase: 'hero',
      title: '',
      description: '',
      proficiency: '',
      language: 'en-US',
      tags: [],
      status: 'designing',
      roles: [],
      milestones: [],
      submissions: [],
      evaluations: [],
      threads: [],
      engagementEvents: [],
      createdAt: '2026-05-25T08:00:00.000Z',
      updatedAt: '2026-05-25T08:00:00.000Z',
    });
    expect(err.name).toBe('PlannerV2Error');
    expect(err.partial.milestones).toEqual([]);
  });
});

describe('PBL v2 Planner — error paths (no LLM needed)', () => {
  it('throws PlannerV2Error when outline.pblConfig is missing', async () => {
    const input = plannerInput({
      outline: pblOutline({ pblConfig: undefined }),
    });

    // We pass `undefined as never` for the language model because the
    // function fails before any LLM call — the `pblConfig` check is
    // the first thing it does. Using `as never` keeps the test
    // payload honest (we are deliberately violating the contract to
    // observe the guard).
    await expect(generatePBLV2Project(input, undefined as never)).rejects.toBeInstanceOf(
      PlannerV2Error,
    );
  });
});

describe('PBL v2 Planner — completion gate', () => {
  it('does not accept design completion while a milestone has no microtasks', () => {
    const project = minimalPlannerProject({
      milestones: [
        {
          id: 'milestone-empty',
          title: 'Prepare analysis plan',
          status: 'locked',
          order: 0,
          microtasks: [],
          documents: [],
        },
      ],
    });

    expect(plannerCompletionGaps(project)).toContain(
      'milestone "Prepare analysis plan" has no microtasks',
    );
  });

  it('accepts design completion only after all required project structure exists', () => {
    expect(plannerCompletionGaps(minimalPlannerProject())).toEqual([]);
  });

  it('rejects ordinary PBL hidden documents because the workspace does not render them', () => {
    const project = minimalPlannerProject();
    project.milestones[0].documents = [
      {
        id: 'doc-hidden',
        title: 'Hidden primer',
        content: 'This would not be visible in the ordinary PBL workspace.',
        docType: 'reference',
      },
    ];

    expect(plannerCompletionGaps(project).some((g) => g.includes('hidden documents'))).toBe(true);
  });

  it('ordinary projects are unaffected by the scenario flag being off (no scenario gaps)', () => {
    // No opts → scenario checks never run; byte-identical to before.
    expect(plannerCompletionGaps(minimalPlannerProject())).toEqual([]);
    // Explicit false behaves the same.
    expect(plannerCompletionGaps(minimalPlannerProject(), { scenarioRoleplay: false })).toEqual([]);
  });

  it('only stops the planner loop after mark_design_complete returns ok=true', () => {
    const rejectedStep = {
      toolResults: [
        {
          toolName: 'mark_design_complete',
          output: {
            ok: false,
            gaps: ['milestone "Prepare analysis plan" has no microtasks'],
            nextAction: 'Call add_microtask for milestoneId="milestone-empty".',
          },
        },
      ],
    } as StepResult<ToolSet>;
    const acceptedStep = {
      toolResults: [
        {
          toolName: 'mark_design_complete',
          output: { ok: true },
        },
      ],
    } as StepResult<ToolSet>;

    expect(plannerStepHasAcceptedCompletion(rejectedStep)).toBe(false);
    expect(plannerStepHasAcceptedCompletion(acceptedStep)).toBe(true);
  });
});

describe('PBL v2 Planner — scenario completion gate (no LLM needed)', () => {
  function lightMicrotask(id: string, title: string) {
    return { id, title, status: 'todo' as const, assignee: 'user' as const, hints: [], order: 0 };
  }

  // A coherent role-play scenario project: full three-stage skeleton
  // (prep → scene → wrapup) + a cast with name/persona/situation.
  function scenarioProject(overrides?: Partial<PBLProjectV2>): PBLProjectV2 {
    return minimalPlannerProject({
      scenario: {
        setting: '校园咖啡馆的午后',
        sceneVisual: {
          caption: '校园咖啡馆的安静午后',
          bg1: '#3a2740',
          bg2: '#2c1f30',
          accent: '#ffb38a',
          motifs: ['☕', '📚'],
        },
        characters: [
          {
            id: 'char-1',
            name: '小敏',
            persona: '内向的同学，说话轻声细语',
            situation: '这周被一门考试压得喘不过气，情绪低落',
          },
        ],
      },
      schemaVersion: 1,
      milestones: [
        {
          id: 'ms-prep',
          title: '准备',
          status: 'active',
          order: 0,
          scenarioStage: 'prep',
          microtasks: [lightMicrotask('mt-prep', '了解背景')],
          documents: [],
        },
        {
          id: 'ms-scene',
          title: '初次搭话',
          status: 'locked',
          order: 1,
          scenarioStage: 'roleplay',
          microtasks: [
            {
              ...lightMicrotask('beat-1', '打招呼'),
              completionCriteria: '学习者向小敏打了招呼并对她的回应做出回复',
            },
          ],
          documents: [],
        },
        {
          id: 'ms-wrapup',
          title: '收尾',
          status: 'locked',
          order: 2,
          scenarioStage: 'wrapup',
          microtasks: [lightMicrotask('mt-wrap', '听取反馈')],
          documents: [],
        },
      ],
      ...overrides,
    });
  }

  it('accepts a coherent scenario project (cast + prep/scene/wrapup skeleton)', () => {
    expect(plannerCompletionGaps(scenarioProject(), { scenarioRoleplay: true })).toEqual([]);
  });

  it('flags a scenario project that never called set_scenario', () => {
    const p = scenarioProject({ scenario: undefined });
    const gaps = plannerCompletionGaps(p, { scenarioRoleplay: true });
    expect(gaps.some((g) => g.includes('set_scenario was never called'))).toBe(true);
  });

  it('flags a character missing name, persona, or situation', () => {
    const p = scenarioProject();
    p.scenario!.characters = [{ id: 'char-1', name: '小敏', persona: '内向', situation: '   ' }];
    const gaps = plannerCompletionGaps(p, { scenarioRoleplay: true });
    expect(gaps.some((g) => g.includes('missing name, persona, or situation'))).toBe(true);
  });

  it('flags a scenario project with no scene stage', () => {
    const p = scenarioProject();
    // turn the scene stage into a plain prep so there is no 'roleplay'
    p.milestones[1].scenarioStage = 'prep';
    const gaps = plannerCompletionGaps(p, { scenarioRoleplay: true });
    expect(gaps.some((g) => g.includes('scenarioStage:"roleplay"'))).toBe(true);
  });

  it('flags when the first milestone is not prep / last is not wrapup', () => {
    const p = scenarioProject();
    p.milestones[0].scenarioStage = 'roleplay'; // first no longer prep
    const gaps = plannerCompletionGaps(p, { scenarioRoleplay: true });
    expect(gaps.some((g) => g.includes('FIRST milestone must be scenarioStage:"prep"'))).toBe(true);
  });

  it('flags a scenario project that never authored a scene visual (set_scene_visual)', () => {
    const p = scenarioProject();
    p.scenario!.sceneVisual = undefined;
    const gaps = plannerCompletionGaps(p, { scenarioRoleplay: true });
    expect(gaps.some((g) => g.includes('set_scene_visual'))).toBe(true);
  });

  it('flags a scene visual with a caption but no emoji motifs', () => {
    const p = scenarioProject();
    p.scenario!.sceneVisual = { caption: '某处', motifs: [] };
    const gaps = plannerCompletionGaps(p, { scenarioRoleplay: true });
    expect(gaps.some((g) => g.includes('set_scene_visual'))).toBe(true);
  });

  it('does NOT apply scenario checks when the flag is off, even if scenario data is incomplete', () => {
    // Defensive: an ordinary project must never be blocked by scenario
    // gaps, regardless of any stray fields.
    const p = scenarioProject({
      scenario: undefined,
      milestones: minimalPlannerProject().milestones,
    });
    expect(plannerCompletionGaps(p)).toEqual([]);
  });

  it('packaged scenario survives a JSON serialization round-trip unchanged', () => {
    const p = scenarioProject();
    const roundTripped = JSON.parse(JSON.stringify(p)) as PBLProjectV2;
    expect(roundTripped).toEqual(p);
    // And it is still recognised as a valid v2 project + still coherent.
    expect(plannerCompletionGaps(roundTripped, { scenarioRoleplay: true })).toEqual([]);
  });
});

describe('PBL v2 Planner — targetLanguage overrides detection (UI locale path)', () => {
  it('Planner uses targetLanguage when present, ignoring outline content', async () => {
    // Outline content is in English (LeetCode/CSV style) but the
    // user explicitly chose zh-CN in the UI switcher. The Planner
    // MUST honour the UI choice — this is the regression we fixed.
    const outline: SceneOutline = {
      id: 'o',
      type: 'pbl',
      title: 'Personal Finance Dashboard',
      description: 'Build a React dashboard for personal finances.',
      keyPoints: ['React', 'Charts', 'State management'],
      order: 1,
      pblConfig: {
        projectTopic: 'Personal Finance Dashboard',
        projectDescription: 'Build a React dashboard for personal finances.',
        targetSkills: ['React'],
        issueCount: 3,
      },
    };
    const input: PBLPlannerV2Input = {
      outline,
      courseContext: {
        allOutlines: [outline],
        languageDirective: 'Reply in English.',
      },
      targetLanguage: 'zh-CN',
    };
    // We can't run the full agentic loop without an LLM, but the
    // pblConfig guard fires first; the resulting `partial` project
    // still went through `emptyProject` so we can read its language.
    try {
      await generatePBLV2Project(
        { ...input, outline: { ...outline, pblConfig: undefined } },
        undefined as never,
      );
    } catch (err) {
      // `partial` was built via emptyProject(input), which now reads
      // targetLanguage first. Confirm the override is respected.
      const partial = (err as PlannerV2Error).partial;
      expect(partial.language).toBe('zh-CN');
    }
  });

  it('leaves language blank when no targetLanguage is given (Hero locale-sync fills it)', async () => {
    const outline: SceneOutline = {
      id: 'o',
      type: 'pbl',
      title: 'Personal Finance Dashboard',
      description: 'Build a React dashboard.',
      keyPoints: ['React'],
      order: 1,
      pblConfig: {
        projectTopic: 'Personal Finance Dashboard',
        projectDescription: 'Build a React dashboard.',
        targetSkills: ['React'],
        issueCount: 3,
      },
    };
    const input: PBLPlannerV2Input = {
      outline: { ...outline, pblConfig: undefined },
      courseContext: {
        allOutlines: [outline],
        languageDirective: 'Reply in English.',
      },
      // No targetLanguage → language stays '' (no content-based locale guessing).
    };
    try {
      await generatePBLV2Project(input, undefined as never);
    } catch (err) {
      const partial = (err as PlannerV2Error).partial;
      expect(partial.language).toBe('');
    }
  });

  it('whitespace-only targetLanguage leaves language blank (no content guessing)', async () => {
    const outline: SceneOutline = pblOutline({
      description: '通过 Java 实现一个 HashMap 词频统计程序',
      pblConfig: {
        projectTopic: '用 HashMap 统计词频',
        projectDescription: '通过 Java 实现一个 HashMap 词频统计程序',
        targetSkills: ['HashMap'],
        issueCount: 3,
      },
    });
    const input: PBLPlannerV2Input = {
      outline: { ...outline, pblConfig: undefined },
      courseContext: {
        allOutlines: [outline],
        languageDirective: '',
      },
      targetLanguage: '   ',
    };
    try {
      await generatePBLV2Project(input, undefined as never);
    } catch (err) {
      const partial = (err as PlannerV2Error).partial;
      // whitespace targetLanguage → '' (content is NOT scanned for a locale)
      expect(partial.language).toBe('');
    }
  });
});

describe('PBL v2 Planner — normalizeSynthesisChecks (P1 deterministic cap/fallback)', () => {
  function ms(id: string, order: number, extra: Partial<PBLMilestone> = {}): PBLMilestone {
    return {
      id,
      title: `Stage ${order}`,
      description: '',
      status: order === 0 ? 'active' : 'locked',
      order,
      microtasks: [
        { id: `${id}-mt`, title: 't', status: 'todo', assignee: 'user', hints: [], order: 0 },
      ],
      documents: [],
      ...extra,
    };
  }

  function project(milestones: PBLMilestone[], learningObjective = ''): PBLProjectV2 {
    return {
      uiPhase: 'workspace',
      title: 'Build a thing',
      description: 'desc',
      learningObjective,
      proficiency: 'beginner',
      language: 'zh-CN',
      tags: [],
      status: 'active',
      roles: [{ id: 'r', type: 'instructor', name: 'I' }],
      milestones,
      submissions: [],
      evaluations: [],
      threads: [],
      engagementEvents: [],
      createdAt: 'x',
      updatedAt: 'x',
    };
  }

  it('caps to MAX_SYNTHESIS_STAGES when the planner over-flags, keeping the most relevant', () => {
    const p = project(
      [
        ms('m0', 0, { title: '循环与迭代', synthesisCheck: { coreConcept: '循环' } }),
        ms('m1', 1, { title: '环境设置', synthesisCheck: { coreConcept: '安装' } }),
        ms('m2', 2, { title: '收尾打包', synthesisCheck: { coreConcept: '打包' } }),
      ],
      '学会用循环处理列表',
    );
    normalizeSynthesisChecks(p);
    const flagged = p.milestones.filter((m) => m.synthesisCheck);
    expect(flagged.length).toBe(MAX_SYNTHESIS_STAGES);
    // The loop-related stage is most relevant to the objective and must survive.
    expect(p.milestones.find((m) => m.id === 'm0')?.synthesisCheck).toBeTruthy();
  });

  it('adds exactly one synthesisCheck when the planner flagged none', () => {
    const p = project([ms('m0', 0), ms('m1', 1), ms('m2', 2)], '学会用循环处理列表');
    normalizeSynthesisChecks(p);
    const flagged = p.milestones.filter((m) => m.synthesisCheck);
    expect(flagged.length).toBe(1);
    expect(flagged[0].synthesisCheck?.coreConcept).toBeTruthy();
  });

  it('leaves a valid 1-2 flagged set untouched', () => {
    const p = project([
      ms('m0', 0, { synthesisCheck: { coreConcept: 'A' } }),
      ms('m1', 1),
      ms('m2', 2),
    ]);
    normalizeSynthesisChecks(p);
    expect(p.milestones.filter((m) => m.synthesisCheck).length).toBe(1);
    expect(p.milestones[0].synthesisCheck?.coreConcept).toBe('A');
  });

  it('picks the median stage as fallback when nothing aligns', () => {
    const p = project([ms('m0', 0), ms('m1', 1), ms('m2', 2)], 'zzz-unrelated-objective');
    normalizeSynthesisChecks(p);
    // 3 stages, all-zero overlap → median index 1.
    expect(p.milestones.find((m) => m.id === 'm1')?.synthesisCheck).toBeTruthy();
    expect(p.milestones.filter((m) => m.synthesisCheck).length).toBe(1);
  });
});

describe('PBL v2 Planner — progress event type', () => {
  it('PlannerV2Callbacks.onProgress accepts all known event kinds (compile check)', () => {
    // This is a pure type-check assertion: it ensures
    // `PlannerV2ProgressEvent` covers all the variants the Generating
    // page needs to render. If a new event kind is added without
    // updating the discriminated union, this won't compile.
    const events: PlannerV2ProgressEvent[] = [
      { kind: 'project_info', title: 't' },
      { kind: 'role', roleType: 'instructor', name: 'Instructor' },
      { kind: 'milestone', title: 'm', index: 0 },
      { kind: 'microtask', milestoneTitle: 'm', title: 'mt', index: 0 },
      { kind: 'complete', milestoneCount: 3, microtaskCount: 9 },
    ];
    expect(events).toHaveLength(5);

    // And the callback signature compiles
    const cb: PlannerV2Callbacks = {
      onProgress: (e) => {
        // exhaustiveness check via never
        switch (e.kind) {
          case 'project_info':
          case 'role':
          case 'milestone':
          case 'microtask':
          case 'complete':
            return;
          default: {
            const _exhaustive: never = e;
            return _exhaustive;
          }
        }
      },
    };
    expect(cb.onProgress).toBeDefined();
  });
});
