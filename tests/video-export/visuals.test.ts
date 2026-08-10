import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/dsl';
import { upgradeLegacyPBLConfigToProjectV2, type PBLProjectConfig } from '@/lib/pbl/legacy/read';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import {
  compileVideoTimeline,
  emitManifest,
  type CompilerScene,
  type PblCoverVisual,
} from '@/lib/video-export';
import { NO_ASSETS, stubProbe } from './helpers';

const speech = (id: string, text = 'Narration'): Action => ({ id, type: 'speech', text }) as Action;

function quizScene(content: Record<string, unknown>, title = 'Quiz <Checkpoint>'): CompilerScene {
  return {
    id: 'quiz-1',
    stageId: 'stage',
    title,
    order: 0,
    type: 'quiz',
    content: { type: 'quiz', ...content },
    actions: [speech('quiz-speech')],
  } as CompilerScene;
}

function pblScene(content: Record<string, unknown>): CompilerScene {
  return {
    id: 'pbl-1',
    stageId: 'stage',
    title: 'Scene fallback',
    order: 0,
    type: 'pbl',
    content: { type: 'pbl', ...content },
    actions: [speech('pbl-speech')],
  } as CompilerScene;
}

function compile(scene: CompilerScene) {
  return compileVideoTimeline(
    { stage: { id: 'stage', name: 'Visual cards' }, scenes: [scene] },
    { timing: stubProbe({ 'quiz-speech': 2400, 'pbl-speech': 3600 }), assets: NO_ASSETS },
  );
}

const nonRunnableV2Mutations: Array<[string, (project: PBLProjectV2) => void]> = [
  [
    'all milestones have empty microtasks',
    (project) => {
      project.milestones.forEach((milestone) => {
        milestone.microtasks = [];
      });
    },
  ],
  [
    'one milestone has no microtasks',
    (project) => {
      project.milestones.at(-1)!.microtasks = [];
    },
  ],
  [
    'there is no Instructor role',
    (project) => {
      project.roles.forEach((role) => {
        role.type = 'mentor';
      });
    },
  ],
  [
    'the Instructor has no id',
    (project) => {
      Reflect.deleteProperty(project.roles.find((role) => role.type === 'instructor')!, 'id');
    },
  ],
  [
    'the Instructor has no name',
    (project) => {
      Reflect.deleteProperty(project.roles.find((role) => role.type === 'instructor')!, 'name');
    },
  ],
  [
    'a microtask has no id',
    (project) => {
      Reflect.deleteProperty(project.milestones.at(-1)!.microtasks.at(-1)!, 'id');
    },
  ],
  [
    'a microtask has no title',
    (project) => {
      Reflect.deleteProperty(project.milestones.at(-1)!.microtasks.at(-1)!, 'title');
    },
  ],
];

describe('video-export cover visual pass', () => {
  it('builds a whole-scene Quiz cover from authored questions and default points', () => {
    const ir = compile(
      quizScene({
        questions: [
          {
            id: 'q1',
            type: 'single',
            question: 'Never exported',
            answer: ['SECRET_ANSWER'],
            analysis: 'SECRET_ANALYSIS',
            points: 4,
          },
          { id: 'q2', type: 'short_answer', question: 'Also hidden' },
        ],
        runtimeAnswers: { q1: 'SECRET_RUNTIME_ANSWER' },
      }),
    );

    expect(ir.version).toBe(3);
    expect(ir.scenes[0]).toMatchObject({
      supported: true,
      base: { kind: 'visual-segments' },
      visuals: [
        {
          kind: 'quiz-cover',
          startMs: 0,
          durationMs: 2400,
          title: 'Quiz <Checkpoint>',
          questionCount: 2,
          totalPoints: 5,
        },
      ],
    });
    expect(JSON.stringify(ir)).not.toMatch(/SECRET_(ANSWER|ANALYSIS|RUNTIME_ANSWER)/);
    expect(() => emitManifest(ir)).not.toThrow();
  });

  it('preserves a long Quiz title and emits zero counts for an empty question list', () => {
    const title =
      'Quiz：这是一个用于验证视觉 IR 不截断源文本的超长标题 SupercalifragilisticexpialidociousWithoutBreaks';
    const visual = compile(quizScene({ questions: [] }, title)).scenes[0].visuals[0];

    expect(visual).toEqual({
      kind: 'quiz-cover',
      startMs: 0,
      durationMs: 2400,
      title,
      questionCount: 0,
      totalPoints: 0,
    });
  });

  it('uses PBL v2 design fields, gains fallback rules, and learner-safe people summaries', () => {
    const ir = compile(
      pblScene({
        projectV2: {
          title: 'Build <Safe> Systems',
          description: 'A deterministic project',
          learningObjective: 'Fallback objective',
          gains: ['  Model threats  ', '', 'Escape output'],
          roles: [
            {
              id: 'instructor',
              type: 'instructor',
              name: 'Dr. Guide',
              description: 'Learner-facing summary',
              systemPrompt: 'SECRET_PERSONA',
            },
          ],
          milestones: [
            { id: 'm1', microtasks: [{ id: 't1' }, { id: 't2' }] },
            { id: 'm2', microtasks: [{ id: 't3' }] },
          ],
          scenario: {
            setting: 'SECRET_SITUATION',
            characters: [
              {
                id: 'character',
                name: 'Alex & Sam',
                persona: 'SECRET_CHARACTER_PERSONA',
                situation: 'SECRET_CHARACTER_SITUATION',
              },
            ],
          },
          threads: [{ messages: [{ content: 'SECRET_CHAT' }] }],
          submissions: [{ content: 'SECRET_SUBMISSION' }],
          evaluations: [],
          engagementEvents: [],
        },
        projectConfig: {
          projectInfo: { title: 'Legacy title', description: 'Legacy description' },
          issueboard: { issues: [] },
          agents: [],
          chat: { messages: [{ message: 'SECRET_LEGACY_CHAT' }] },
        },
      }),
    );

    expect(ir.scenes[0].visuals).toEqual([
      {
        kind: 'pbl-cover',
        startMs: 0,
        durationMs: 3600,
        title: 'Build <Safe> Systems',
        description: 'A deterministic project',
        gains: ['Model threats', 'Escape output'],
        stageCount: 2,
        taskCount: 3,
        instructorName: 'Dr. Guide',
        instructorDescription: 'Learner-facing summary',
        scenarioCharacterName: 'Alex & Sam',
      },
    ]);
    expect(JSON.stringify(ir)).not.toMatch(
      /SECRET_(PERSONA|SITUATION|CHARACTER_PERSONA|CHARACTER_SITUATION|CHAT|SUBMISSION|LEGACY_CHAT)/,
    );
  });

  it('falls back from missing v2 gains to learningObjective', () => {
    const visual = compile(
      pblScene({
        projectV2: {
          title: 'Legacy v2',
          description: '',
          learningObjective: 'Understand deterministic exports',
          roles: [],
          milestones: [],
        },
      }),
    ).scenes[0].visuals[0] as PblCoverVisual;

    expect(visual.gains).toEqual(['Understand deterministic exports']);
  });

  it('selects an authored instructor after the reserved compatibility role', () => {
    const visual = compile(
      pblScene({
        projectV2: {
          title: 'Authored project',
          description: '',
          roles: [
            {
              id: 'role-compat-instructor',
              type: 'instructor',
              name: 'Synthetic Instructor',
            },
            {
              id: 'role-authored-instructor',
              type: 'instructor',
              name: 'Dr. Guide',
              description: 'Learner-facing summary',
            },
          ],
          milestones: [],
        },
      }),
    ).scenes[0].visuals[0] as PblCoverVisual;

    expect(visual.instructorName).toBe('Dr. Guide');
    expect(visual.instructorDescription).toBe('Learner-facing summary');
    expect(JSON.stringify(visual)).not.toContain('Synthetic Instructor');
  });

  it('uses scene-safe defaults when PBL design fields are missing', () => {
    const visual = compile(pblScene({})).scenes[0].visuals[0];

    expect(visual).toEqual({
      kind: 'pbl-cover',
      startMs: 0,
      durationMs: 3600,
      title: 'Scene fallback',
      description: '',
      gains: [],
      stageCount: 0,
      taskCount: 0,
    });
  });

  /**
   * Shaped like the real v1 generator: the design prompt asks for 2–4
   * development roles the learner picks between, `createAgent` always writes
   * `is_user_role: false` (the learner is tracked by `selectedRole`), and the
   * issueboard appends a Question/Judge agent per issue.
   */
  const legacyProjectConfig = (progress: {
    activeIssue: 'root' | 'child';
    chat: string;
  }): PBLProjectConfig => ({
    projectInfo: { title: 'Legacy Project', description: 'Legacy description' },
    agents: [
      {
        name: 'Data Analyst',
        actor_role: '数据分析师',
        role_division: 'development',
        is_user_role: false,
        is_system_agent: false,
        system_prompt: 'SECRET_AGENT_PROMPT',
        default_mode: 'idle',
        delay_time: 0,
        env: {},
        is_active: true,
      },
      {
        name: 'Frontend Developer',
        actor_role: '前端开发',
        role_division: 'development',
        is_user_role: false,
        is_system_agent: false,
        system_prompt: '',
        default_mode: 'idle',
        delay_time: 0,
        env: {},
        is_active: true,
      },
      {
        name: 'Question Agent - root',
        actor_role: 'Question Agent',
        role_division: 'management',
        is_user_role: false,
        is_system_agent: true,
        system_prompt: '',
        default_mode: 'idle',
        delay_time: 0,
        env: {},
        is_active: true,
      },
      {
        name: 'Judge Agent - root',
        actor_role: 'Judge Agent',
        role_division: 'management',
        is_user_role: false,
        is_system_agent: true,
        system_prompt: '',
        default_mode: 'idle',
        delay_time: 0,
        env: {},
        is_active: true,
      },
      {
        name: 'Question Agent - child',
        actor_role: 'Question Agent',
        role_division: 'management',
        is_user_role: false,
        is_system_agent: true,
        system_prompt: '',
        default_mode: 'idle',
        delay_time: 0,
        env: {},
        is_active: true,
      },
    ],
    issueboard: {
      agent_ids: ['Question Agent - root', 'Judge Agent - root', 'Question Agent - child'],
      current_issue_id: progress.activeIssue,
      issues: [
        {
          id: 'root',
          title: 'Root task',
          description: 'Root description',
          person_in_charge: 'Data Analyst',
          participants: ['Question Agent - root'],
          notes: '',
          parent_issue: null,
          index: 0,
          is_done: progress.activeIssue !== 'root',
          is_active: progress.activeIssue === 'root',
          generated_questions: 'Root question',
          question_agent_name: 'Question Agent - root',
          judge_agent_name: 'Judge Agent - root',
        },
        {
          id: 'child',
          title: 'Child task',
          description: 'Child description',
          person_in_charge: 'Data Analyst',
          participants: ['Question Agent - child'],
          notes: '',
          parent_issue: 'root',
          index: 1,
          is_done: false,
          is_active: progress.activeIssue === 'child',
          generated_questions: 'Child question',
          question_agent_name: 'Question Agent - child',
          judge_agent_name: 'Judge Agent - root',
        },
      ],
    },
    chat: {
      messages: [
        {
          id: 'message',
          agent_name: 'Question Agent - root',
          message: progress.chat,
          timestamp: 1780272000000,
          read_by: [],
        },
      ],
    },
    selectedRole: progress.activeIssue === 'child' ? 'Data Analyst' : null,
  });

  it('builds a stable legacy PBL cover without reading chat or progress state', () => {
    const first = compile(
      pblScene({ projectConfig: legacyProjectConfig({ activeIssue: 'root', chat: 'SECRET_A' }) }),
    ).scenes[0].visuals;
    const second = compile(
      pblScene({ projectConfig: legacyProjectConfig({ activeIssue: 'child', chat: 'SECRET_B' }) }),
    ).scenes[0].visuals;

    expect(first).toEqual(second);
    expect(first).toEqual([
      {
        kind: 'pbl-cover',
        startMs: 0,
        durationMs: 3600,
        title: 'Legacy Project',
        description: 'Legacy description',
        gains: [],
        stageCount: 1,
        taskCount: 2,
      },
    ]);
  });

  it('uses legacy cover fields when a hybrid scene has malformed projectV2', () => {
    const visual = compile(
      pblScene({
        projectConfig: legacyProjectConfig({ activeIssue: 'root', chat: '' }),
        projectV2: { title: 'broken' },
      }),
    ).scenes[0].visuals[0];

    expect(visual).toEqual({
      kind: 'pbl-cover',
      startMs: 0,
      durationMs: 3600,
      title: 'Legacy Project',
      description: 'Legacy description',
      gains: [],
      stageCount: 1,
      taskCount: 2,
    });
  });

  it('uses legacy cover fields when a hybrid v2 project has no milestones', () => {
    const projectConfig = legacyProjectConfig({ activeIssue: 'root', chat: '' });
    const projectV2 = upgradeLegacyPBLConfigToProjectV2(projectConfig);
    projectV2.title = 'Empty v2 title';
    projectV2.milestones = [];

    const visual = compile(pblScene({ projectConfig, projectV2 })).scenes[0].visuals[0];

    expect(visual).toMatchObject({
      kind: 'pbl-cover',
      title: 'Legacy Project',
      stageCount: 1,
      taskCount: 2,
    });
  });

  it.each(nonRunnableV2Mutations)(
    'uses legacy cover fields when a hybrid v2 project is non-runnable because %s',
    (_label, makeNonRunnable) => {
      const projectConfig = legacyProjectConfig({ activeIssue: 'root', chat: '' });
      const projectV2 = upgradeLegacyPBLConfigToProjectV2(projectConfig);
      projectV2.title = 'Non-runnable v2 title';
      makeNonRunnable(projectV2);

      const visual = compile(pblScene({ projectConfig, projectV2 })).scenes[0].visuals[0];

      expect(visual).toMatchObject({
        kind: 'pbl-cover',
        title: 'Legacy Project',
        stageCount: 1,
        taskCount: 2,
      });
    },
  );

  it('keeps a partial projectV2 cover when the legacy config is an empty stub', () => {
    const visual = compile(
      pblScene({
        projectConfig: {},
        projectV2: { title: 'Recoverable v2 title' },
      }),
    ).scenes[0].visuals[0];

    expect(visual).toMatchObject({
      kind: 'pbl-cover',
      title: 'Recoverable v2 title',
    });
  });

  it.each(nonRunnableV2Mutations)(
    'keeps the permissive v2-only cover when %s',
    (_label, makeNonRunnable) => {
      const projectV2 = upgradeLegacyPBLConfigToProjectV2(
        legacyProjectConfig({ activeIssue: 'root', chat: '' }),
      );
      projectV2.title = 'Recoverable non-runnable v2';
      makeNonRunnable(projectV2);

      const visual = compile(pblScene({ projectV2 })).scenes[0].visuals[0];

      expect(visual).toMatchObject({
        kind: 'pbl-cover',
        title: 'Recoverable non-runnable v2',
      });
    },
  );

  it('keeps the permissive v2 cover when a damaged hybrid legacy shell has no issues', () => {
    const projectConfig = legacyProjectConfig({ activeIssue: 'root', chat: '' });
    projectConfig.issueboard.issues = [];

    const visual = compile(
      pblScene({ projectConfig, projectV2: { title: 'Recoverable damaged v2' } }),
    ).scenes[0].visuals[0];

    expect(visual).toMatchObject({
      kind: 'pbl-cover',
      title: 'Recoverable damaged v2',
      stageCount: 0,
      taskCount: 0,
    });
  });

  /**
   * A v1 roster holds student roles and issueboard bots, never a tutor, so no
   * agent on it may be promoted onto the cover as one.
   */
  it('never names an instructor for a legacy project', () => {
    const visual = compile(
      pblScene({ projectConfig: legacyProjectConfig({ activeIssue: 'root', chat: '' }) }),
    ).scenes[0].visuals[0] as PblCoverVisual;

    expect(visual.instructorName).toBeUndefined();
    expect(JSON.stringify(visual)).not.toMatch(/Data Analyst|Frontend Developer|Question Agent/);
  });

  /**
   * Upgrading flattens the issue tree, so a migrated project reports one stage
   * per issue instead of the single authored root the legacy path sees above.
   * The cover reports whatever the stored project holds; restoring hierarchy is
   * a compat concern tracked on its own. What this pass owns is that neither the
   * counts nor the people move with learner progress -- the compat roster names
   * its instructor after the active issue, so the cover must drop that role
   * rather than repeat a progress-derived name.
   */
  it('keeps migrated legacy cover counts and people stable across progress', () => {
    const compileMigrated = (activeIssue: 'root' | 'child', chat: string) =>
      compile(
        pblScene({
          projectV2: upgradeLegacyPBLConfigToProjectV2(legacyProjectConfig({ activeIssue, chat })),
        }),
      ).scenes[0].visuals;

    const first = compileMigrated('root', 'SECRET_A');
    const second = compileMigrated('child', 'SECRET_B');

    expect(first).toEqual(second);
    expect(first).toEqual([
      {
        kind: 'pbl-cover',
        startMs: 0,
        durationMs: 3600,
        title: 'Legacy Project',
        description: 'Legacy description',
        gains: [],
        stageCount: 2,
        taskCount: 2,
      },
    ]);
    expect(JSON.stringify(first)).not.toMatch(/Question Agent|Instructor/);
  });

  it('keeps unprepared interactive scenes unsupported while Quiz and PBL get informational diagnostics', () => {
    const interactive = {
      id: 'interactive',
      stageId: 'stage',
      title: 'Runtime widget',
      order: 2,
      type: 'interactive',
      content: { type: 'interactive', html: '<p>runtime</p>' },
      actions: [],
    } as CompilerScene;
    const scenes = [quizScene({ questions: [] }), { ...pblScene({}), order: 1 }, interactive];
    const ir = compileVideoTimeline(
      { stage: { id: 'stage', name: 'Mixed' }, scenes },
      { timing: stubProbe(), assets: NO_ASSETS },
    );

    expect(ir.diagnostics.filter((d) => d.code === 'cover-card').map((d) => d.sceneId)).toEqual([
      'quiz-1',
      'pbl-1',
    ]);
    expect(
      ir.diagnostics.filter((d) => d.code === 'unsupported-scene').map((d) => d.sceneId),
    ).toEqual(['interactive']);
    expect(ir.scenes[2]).toMatchObject({
      supported: false,
      base: { kind: 'placeholder' },
    });
    expect(ir.scenes[2].markers).toContainEqual(
      expect.objectContaining({ kind: 'unsupported-scene' }),
    );
  });
});
