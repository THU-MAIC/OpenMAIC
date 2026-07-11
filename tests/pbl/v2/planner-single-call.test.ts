/**
 * PBL v2 — Single-call Planner tests.
 *
 * Exercises `generatePBLV2ProjectSingleCall` end-to-end with a mocked
 * language model (`MockLanguageModelV3`) whose `doGenerate` returns
 * scripted JSON text. The deterministic hydration + post-processing
 * (ids / status / order / assignee / thread bootstrap / synthesis
 * normalization / completion gate) runs for real, so these assert the
 * full parse → hydrate → normalize path without a live LLM.
 */
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';

import { generatePBLV2ProjectSingleCall } from '@/lib/pbl/v2/agents/planner-single-call';
import { PlannerV2Error } from '@/lib/pbl/v2/agents/planner';
import { PBL_SIMULATOR_AGENT_ID } from '@/lib/pbl/v2/operations/progress';
import type { SceneOutline } from '@/lib/types/generation';
import type { PBLPlannerV2Input } from '@/lib/pbl/v2/types';

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** A model whose `doGenerate` replays the given text responses in order. */
function textModel(...responses: string[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const text = responses[Math.min(i, responses.length - 1)];
      i++;
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

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
      issueCount: 2,
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
      // Non-empty directive → languageDirective set → BCP-47 language
      // guard is skipped (parity with the loop), so English content is
      // accepted in these fixtures.
      languageDirective: 'Reply in English.',
    },
    ...overrides,
  };
}

/** A valid, on-topic project JSON the LLM might emit. */
function validOutput(overrides?: { proficiency?: string; coreConcept?: string }): string {
  return JSON.stringify({
    projectInfo: {
      title: 'CSV Data Analyzer project',
      description:
        'Build a small tool that reads a CSV with pandas DataFrame and reports findings.',
      learningObjective: 'Practice File IO and DataFrame analysis end to end.',
      gains: [
        'Understand how a pandas DataFrame represents tabular CSV data',
        'Learn to read and inspect a CSV file with File IO',
        'Turn raw CSV data into a written finding',
      ],
      proficiency: overrides?.proficiency ?? 'beginner',
    },
    instructorRole: {
      name: 'CSV Analysis Coach',
      description: 'Hi! I am your CSV Analysis Coach and I will guide you through every step.',
      systemPrompt: 'You are a warm coach for a CSV data analysis project.',
    },
    milestones: [
      {
        title: 'Load the CSV data',
        description:
          'Create or choose a tiny CSV sample yourself, then read it into a pandas DataFrame.',
        briefing:
          "Let's start with a small CSV you create or choose yourself, then load it into a DataFrame.",
        completionCriteria: 'You have a DataFrame from your own small CSV sample.',
        debrief: 'Great, the data is loaded.',
        ...(overrides?.coreConcept ? { coreConcept: overrides.coreConcept } : {}),
        microtasks: [
          {
            title: 'Prepare a small CSV sample',
            description:
              'Create a few rows of simple tabular data with columns that match the analysis you want to practise.',
            hints: ['Keep the rows small enough that you can inspect them by eye.'],
          },
          {
            title: 'Inspect columns',
            description:
              'Load the CSV and check that the columns and first few rows match the sample you intended.',
            hints: ['Compare the displayed column names against your original sample.'],
          },
        ],
      },
      {
        title: 'Summarize and report',
        description: 'Compute a summary and write findings.',
        briefing: 'Now turn the data into an insight.',
        completionCriteria: 'You wrote a 2-sentence finding.',
        debrief: 'Nicely done — you analyzed a CSV end to end.',
        microtasks: [
          {
            title: 'Aggregate',
            description:
              'Choose one meaningful category and numeric column from your sample, then produce a short summary that is correct for those rows.',
            hints: ['Start by deciding what question your sample data can answer.'],
          },
        ],
      },
    ],
  });
}

describe('PBL v2 single-call planner — happy path', () => {
  it('parses + hydrates a complete project from one JSON response', async () => {
    const project = await generatePBLV2ProjectSingleCall(plannerInput(), textModel(validOutput()));

    expect(project.title).toBe('CSV Data Analyzer project');
    expect(project.status).toBe('active');
    expect(project.uiPhase).toBe('hero');

    // Instructor role: anchored systemPrompt, learner-facing description.
    expect(project.roles).toHaveLength(1);
    const instructor = project.roles[0];
    expect(instructor.type).toBe('instructor');
    expect(instructor.id).toMatch(/^role_/);
    expect(instructor.systemPrompt).toContain('warm coach');
    expect(instructor.systemPrompt).toContain('CSV Data Analyzer project'); // project anchor appended

    // Thread bootstrapped for the instructor.
    expect(project.threads).toHaveLength(1);
    expect(project.threads[0].agentId).toBe(instructor.id);

    // Milestones: ids/order, first active + rest locked (pre-normalize),
    // microtask defaults.
    expect(project.milestones).toHaveLength(2);
    const [m0, m1] = project.milestones;
    expect(m0.id).toMatch(/^ms_/);
    expect(m0.order).toBe(0);
    expect(m0.status).toBe('active');
    expect(m1.status).toBe('locked');

    const t0 = m0.microtasks[0];
    expect(t0.id).toMatch(/^mt_/);
    expect(t0.assignee).toBe('user');
    expect(t0.order).toBe(0);
    expect(t0.hints).toEqual(['Keep the rows small enough that you can inspect them by eye.']);
    // A non-first microtask keeps the hydrated default status.
    expect(m0.microtasks[1].status).toBe('todo');

    // Ordinary PBL is text-only: new generation does not expose hidden documents.
    expect(m1.documents).toBeUndefined();

    // normalizeProjectRuntime: first microtask of the active milestone is
    // promoted to in_progress.
    expect(m0.microtasks[0].status).toBe('in_progress');

    // normalizeSynthesisChecks: with no coreConcept flagged, code adds one
    // to the most relevant stage (1-2 stages get a synthesis check).
    const withSynth = project.milestones.filter((m) => m.synthesisCheck);
    expect(withSynth.length).toBeGreaterThanOrEqual(1);
  });

  it('honors a coreConcept the LLM flagged', async () => {
    const project = await generatePBLV2ProjectSingleCall(
      plannerInput(),
      textModel(validOutput({ coreConcept: 'why a DataFrame beats raw rows' })),
    );
    expect(project.milestones[0].synthesisCheck?.coreConcept).toBe(
      'why a DataFrame beats raw rows',
    );
  });

  it('accepts the LLM proficiency override when no explicit learner level is locked', async () => {
    const project = await generatePBLV2ProjectSingleCall(
      plannerInput(),
      textModel(validOutput({ proficiency: 'advanced' })),
    );
    expect(project.proficiency).toBe('advanced');
  });

  it('parses output even when the model wraps it in ```json fences', async () => {
    const fenced = '```json\n' + validOutput() + '\n```';
    const project = await generatePBLV2ProjectSingleCall(plannerInput(), textModel(fenced));
    expect(project.milestones).toHaveLength(2);
    expect(project.title).toBe('CSV Data Analyzer project');
  });
});

describe('PBL v2 single-call planner — guards + retry', () => {
  it('throws PlannerV2Error when both attempts are invalid', async () => {
    const noMilestones = JSON.stringify({
      projectInfo: {
        title: 'CSV Data Analyzer project',
        description: 'Build a CSV DataFrame tool.',
        learningObjective: 'Practice DataFrame analysis.',
        proficiency: 'beginner',
      },
      instructorRole: { name: 'CSV Coach', description: 'hi', systemPrompt: 'coach' },
      milestones: [],
    });

    await expect(
      generatePBLV2ProjectSingleCall(plannerInput(), textModel(noMilestones, noMilestones)),
    ).rejects.toBeInstanceOf(PlannerV2Error);
  });

  it('throws PlannerV2Error when the response is not JSON at all', async () => {
    await expect(
      generatePBLV2ProjectSingleCall(
        plannerInput(),
        textModel('Sorry, I cannot help with that.', 'Still not JSON.'),
      ),
    ).rejects.toBeInstanceOf(PlannerV2Error);
  });

  it('throws PlannerV2Error when outline.pblConfig is missing (before any LLM call)', async () => {
    const input = plannerInput({ outline: pblOutline({ pblConfig: undefined }) });
    await expect(
      generatePBLV2ProjectSingleCall(input, textModel(validOutput())),
    ).rejects.toBeInstanceOf(PlannerV2Error);
  });

  it('throws PlannerV2Error when gains are missing (parity with the loop set_project_info schema)', async () => {
    const noGains = JSON.parse(validOutput());
    delete noGains.projectInfo.gains;
    const text = JSON.stringify(noGains);
    await expect(
      generatePBLV2ProjectSingleCall(plannerInput(), textModel(text, text)),
    ).rejects.toBeInstanceOf(PlannerV2Error);
  });

  it('throws PlannerV2Error when fewer than 3 gains are provided', async () => {
    const fewGains = JSON.parse(validOutput());
    fewGains.projectInfo.gains = ['Only one gain'];
    const text = JSON.stringify(fewGains);
    await expect(
      generatePBLV2ProjectSingleCall(plannerInput(), textModel(text, text)),
    ).rejects.toBeInstanceOf(PlannerV2Error);
  });

  it('reports a gap (not a raw TypeError) when milestones is not an array', async () => {
    const badShape = JSON.parse(validOutput());
    badShape.milestones = 'I forgot this should be an array';
    const text = JSON.stringify(badShape);
    // Must reject with the PlannerV2Error contract so the caller falls back
    // cleanly — a TypeError from `.forEach` would escape that contract.
    await expect(
      generatePBLV2ProjectSingleCall(plannerInput(), textModel(text, text)),
    ).rejects.toBeInstanceOf(PlannerV2Error);
  });

  it('reports a gap (not a raw TypeError) when a text field is a non-string scalar', async () => {
    const badScalar = JSON.parse(validOutput());
    badScalar.projectInfo.title = 123; // schema drift: number where a string is expected
    const text = JSON.stringify(badScalar);
    await expect(
      generatePBLV2ProjectSingleCall(plannerInput(), textModel(text, text)),
    ).rejects.toBeInstanceOf(PlannerV2Error);
  });

  it('tolerates non-array hints during hydration without crashing', async () => {
    const drift = JSON.parse(validOutput());
    drift.milestones[0].microtasks[0].hints = 'oops, a string not an array';
    const project = await generatePBLV2ProjectSingleCall(
      plannerInput(),
      textModel(JSON.stringify(drift)),
    );
    // Malformed hints coerce to [] — no throw.
    expect(project.milestones[0].microtasks[0].hints).toEqual([]);
  });

  it('rejects an explicit-level mismatch under a learner lock (both attempts wrong → error)', async () => {
    const lockedInput = plannerInput({ user: { requirement: '我是零基础，请用最简单的方式讲' } });
    // Model insists on `advanced` both times — never matches the beginner lock.
    const advanced = validOutput({ proficiency: 'advanced' });
    await expect(
      generatePBLV2ProjectSingleCall(lockedInput, textModel(advanced, advanced)),
    ).rejects.toBeInstanceOf(PlannerV2Error);
  });

  it('accepts a matching proficiency under an explicit learner-level lock', async () => {
    const lockedInput = plannerInput({ user: { requirement: '我是零基础' } });
    const project = await generatePBLV2ProjectSingleCall(lockedInput, textModel(validOutput()));
    expect(project.proficiency).toBe('beginner');
  });

  it('ignores leaked document fields because single-call generation no longer exposes them', async () => {
    const drift = JSON.parse(validOutput());
    drift.milestones[1].documents = [
      { title: 'real doc', content: 'real content', docType: 'reference' },
    ];
    const project = await generatePBLV2ProjectSingleCall(
      plannerInput(),
      textModel(JSON.stringify(drift)),
    );
    expect(project.milestones[1].documents).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario-roleplay single-call
// ---------------------------------------------------------------------------

function scenarioOutline(overrides?: Partial<SceneOutline>): SceneOutline {
  return {
    id: 'outline-pbl-scenario',
    type: 'pbl',
    title: 'Comfort a stressed friend',
    description: 'Practice supporting a friend who is under exam stress.',
    keyPoints: ['active listening', 'empathy'],
    teachingObjective: 'Practice empathetic conversation.',
    order: 1,
    pblConfig: {
      projectTopic: 'Comfort a stressed friend',
      projectDescription: 'Practice supporting a friend who is under exam stress.',
      targetSkills: ['active listening', 'empathy'],
      issueCount: 3,
      scenarioRoleplay: true,
      scenarioBrief: 'A close friend is overwhelmed before finals and hides it.',
    },
    ...overrides,
  };
}

function scenarioInput(overrides?: Partial<PBLPlannerV2Input>): PBLPlannerV2Input {
  const outline = scenarioOutline();
  return {
    outline,
    courseContext: { allOutlines: [outline], languageDirective: 'Reply in English.' },
    ...overrides,
  };
}

/** A valid role-play scenario JSON the LLM might emit. */
function validScenarioOutput(overrides?: { dropCharacters?: boolean }): string {
  return JSON.stringify({
    projectInfo: {
      title: 'Comfort a stressed friend',
      description: 'Step into a chat where you support a friend who is stressed before finals.',
      learningObjective: 'Practice active listening and empathy in a real conversation.',
      gains: [
        'Recognise when a friend is masking stress',
        'Respond with empathy before offering advice',
        'Ask follow-up questions that open someone up',
      ],
      proficiency: 'beginner',
    },
    instructorRole: {
      name: '共情对话教练',
      description: 'Hi! I will set the scene and give you light feedback afterwards.',
      systemPrompt: 'Warm coach for an empathy role-play.',
    },
    scenario: {
      setting: 'A quiet campus café in the late afternoon before finals week.',
      goal: 'Support a stressed friend without rushing to fix things.',
      learnerRole: 'You are their close friend.',
      characters: overrides?.dropCharacters
        ? []
        : [
            {
              name: '小敏',
              persona: 'A soft-spoken classmate who downplays her own feelings.',
              situation: 'Looks tired and says she is "fine" but clearly is not.',
              boundaries: 'Never becomes aggressive; will not self-harm talk.',
              openingLine: '嗨……你怎么来了？',
            },
          ],
      sceneVisual: {
        caption: '期末前的安静咖啡馆',
        bg1: '#3a2740',
        bg2: '#2c1f30',
        accent: '#ffb38a',
        motifs: ['☕', '📚', '🌙'],
      },
    },
    milestones: [
      {
        title: '了解背景',
        description: 'The instructor introduces the situation.',
        briefing: 'Your friend 小敏 seems off. You meet her at the café to check in.',
        completionCriteria: 'You understand the setup.',
        debrief: 'Ready to begin.',
        scenarioStage: 'prep',
        microtasks: [{ title: '准备开始', description: '了解背景，准备进入对话。', hints: [] }],
      },
      {
        title: 'café 对话',
        description: 'You sit down with 小敏.',
        briefing: 'You sit across from her with two warm drinks.',
        completionCriteria: 'You connect with her.',
        debrief: 'You stayed present with her.',
        scenarioStage: 'roleplay',
        microtasks: [
          {
            title: '打开话题',
            description: 'She greets you and looks down at her cup.',
            successWhen: 'You acknowledge how she seems and invite her to share.',
            characterObjective:
              'She privately fears burdening you, and only opens up if you notice she is not really fine.',
            skillFocus: '积极倾听',
            narration: '你们在窗边坐下。',
            hints: ['先共情、别急着给建议'],
          },
          {
            title: '深入倾听',
            description: 'She starts to say a little more.',
            successWhen: 'You reflect her feeling back and ask one follow-up question.',
            characterObjective:
              'She reveals she is afraid of disappointing her parents only if gently probed.',
            skillFocus: '共情回应',
          },
        ],
      },
      {
        title: '收尾',
        description: 'The instructor gives light feedback.',
        briefing: 'Let us wrap up.',
        completionCriteria: 'You hear the feedback.',
        debrief: 'You listened well and gave her room to open up.',
        scenarioStage: 'wrapup',
        microtasks: [{ title: '听取反馈', description: '听取教练的简短反馈。', hints: [] }],
      },
    ],
  });
}

describe('PBL v2 single-call planner — scenario roleplay', () => {
  it('hydrates the scenario block, stages, and beats from one JSON response', async () => {
    const project = await generatePBLV2ProjectSingleCall(
      scenarioInput(),
      textModel(validScenarioOutput()),
    );

    // Scenario frozen onto the project + schema stamped.
    expect(project.scenario).toBeTruthy();
    expect(project.scenario!.setting).toContain('café');
    expect(project.schemaVersion).toBe(1);

    // Character gets a generated id + required fields.
    const char = project.scenario!.characters[0];
    expect(char.id).toMatch(/^char_/);
    expect(char.name).toBe('小敏');
    expect(char.persona).toBeTruthy();
    expect(char.situation).toBeTruthy();

    // Scene visual: caption + motifs + valid hex colours kept.
    expect(project.scenario!.sceneVisual!.caption).toBeTruthy();
    expect(project.scenario!.sceneVisual!.motifs!.length).toBeGreaterThan(0);
    expect(project.scenario!.sceneVisual!.accent).toBe('#ffb38a');

    // Three-stage skeleton.
    expect(project.milestones.map((m) => m.scenarioStage)).toEqual(['prep', 'roleplay', 'wrapup']);

    // Roleplay beats carry their scene fields.
    const roleplay = project.milestones[1];
    const beat0 = roleplay.microtasks[0];
    expect(beat0.successWhen).toBeTruthy();
    expect(beat0.characterObjective).toBeTruthy();
    expect(beat0.skillFocus).toBe('积极倾听');

    // Simulator thread injected by normalizeProjectRuntime for scenario projects.
    expect(project.threads.some((t) => t.agentId === PBL_SIMULATOR_AGENT_ID)).toBe(true);

    // Scenario milestones never carry a synthesisCheck.
    expect(project.milestones.every((m) => !m.synthesisCheck)).toBe(true);
  });

  it('throws PlannerV2Error when the scenario has no characters', async () => {
    const text = validScenarioOutput({ dropCharacters: true });
    await expect(
      generatePBLV2ProjectSingleCall(scenarioInput(), textModel(text, text)),
    ).rejects.toBeInstanceOf(PlannerV2Error);
  });

  it('throws PlannerV2Error when a roleplay beat is missing successWhen', async () => {
    const drift = JSON.parse(validScenarioOutput());
    delete drift.milestones[1].microtasks[0].successWhen;
    const text = JSON.stringify(drift);
    await expect(
      generatePBLV2ProjectSingleCall(scenarioInput(), textModel(text, text)),
    ).rejects.toBeInstanceOf(PlannerV2Error);
  });

  it('throws PlannerV2Error when the stage skeleton is wrong (no wrapup)', async () => {
    const drift = JSON.parse(validScenarioOutput());
    drift.milestones[2].scenarioStage = 'roleplay'; // last is no longer wrapup
    const text = JSON.stringify(drift);
    await expect(
      generatePBLV2ProjectSingleCall(scenarioInput(), textModel(text, text)),
    ).rejects.toBeInstanceOf(PlannerV2Error);
  });
});
