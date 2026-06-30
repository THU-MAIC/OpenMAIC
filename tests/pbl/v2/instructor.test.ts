import { describe, expect, it } from 'vitest';

import {
  buildFirstTaskWorkspaceOrientationBlock,
  buildInstructorRuntimeBrief,
  buildPriorSubmissionsBlock,
  buildScaffoldStateLine,
  buildScenarioAwarenessBlock,
  cleanInstructorCommitText,
  cleanSetupFollowupText,
  ensureNonEmptyInstructorMessages,
  shouldHoldSetupFollowupPreview,
  shouldReportEmptyOutput,
  stageSynthesisOwed,
  stripLeakedToolJson,
  stripOrphanTrailingQuestion,
  stripPrematureNextTaskSetup,
} from '@/lib/pbl/v2/agents/instructor';
import {
  microtaskEngagement,
  milestoneSynthesisSatisfied,
  recordEvent,
} from '@/lib/pbl/v2/operations/engagement';
import type { PBLMilestone, PBLProjectV2 } from '@/lib/pbl/v2/types';

const now = '2026-05-29T00:00:00.000Z';

function milestone(args: Partial<PBLMilestone> & Pick<PBLMilestone, 'id' | 'title' | 'order'>) {
  return {
    status: 'locked',
    description: '',
    microtasks: [],
    documents: [],
    ...args,
  } satisfies PBLMilestone;
}

function makeProject(): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 'Build a HashMap Playground',
    description:
      'Create a tiny interactive project that lets a learner add, lookup, update, and delete keys while seeing collisions at a beginner-friendly level.',
    learningObjective: 'Learn HashMap operations by building and testing a concrete toy tool.',
    proficiency: 'beginner',
    language: 'zh-CN',
    tags: ['hashmap'],
    status: 'active',
    roles: [{ id: 'role-i', type: 'instructor', name: 'Instructor' }],
    milestones: [
      milestone({
        id: 'ms-2',
        title: 'Wire the interactive demo',
        order: 1,
        status: 'locked',
        description: 'Turn the core operations into a visible playground.',
        briefing: 'Connect each operation to a small learner-visible action.',
        completionCriteria: 'The learner can demonstrate add, lookup, update, and delete.',
        microtasks: [
          {
            id: 'mt-3',
            title: 'Add buttons for each operation',
            description: 'Create controls that trigger each HashMap operation.',
            status: 'todo',
            assignee: 'user',
            hints: ['Start with add and lookup before delete.'],
            order: 0,
          },
        ],
        documents: [],
      }),
      milestone({
        id: 'ms-1',
        title: 'Model the core HashMap behavior',
        order: 0,
        status: 'active',
        description: 'Represent the map as buckets and make the basic operations work.',
        briefing: 'Help the learner connect keys, hashes, buckets, and values.',
        completionCriteria:
          'The learner has working behavior and can explain what happens on lookup.',
        microtasks: [
          {
            id: 'mt-2',
            title: 'Implement lookup',
            description: 'Use a key to find the right bucket and return the stored value.',
            status: 'in_progress',
            assignee: 'user',
            hints: ['Ask what should happen when the key is missing.'],
            order: 1,
          },
          {
            id: 'mt-1',
            title: 'Sketch buckets',
            description: 'Draw or describe how keys land in buckets before coding.',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
          },
        ],
        documents: [],
      }),
    ],
    submissions: [
      {
        id: 'sub-1',
        microtaskId: 'mt-2',
        milestoneId: 'ms-1',
        kind: 'text',
        content: 'I wrote lookup and handled missing keys with undefined.',
        createdAt: '2026-05-29T00:10:00.000Z',
      },
    ],
    evaluations: [
      {
        id: 'eval-1',
        kind: 'task',
        microtaskId: 'mt-2',
        milestoneId: 'ms-1',
        feedback: 'Older feedback before the latest submission.',
        strengths: ['Understands buckets'],
        improvements: ['Check missing keys'],
        score: 70,
        createdAt: '2026-05-29T00:05:00.000Z',
      },
    ],
    threads: [{ agentId: 'role-i', messages: [] }],
    engagementEvents: [],
    pendingHandover: {
      completedMilestoneId: 'ms-0',
      completedMilestoneTitle: 'Setup',
      nextMilestoneId: 'ms-1',
      nextMilestoneTitle: 'Model the core HashMap behavior',
      nextTaskId: 'mt-1',
      nextTaskTitle: 'Sketch buckets',
      consumed: false,
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe('PBL v2 — Instructor operating brief', () => {
  it('anchors the instructor in project facts, roadmap, active task, and controls', () => {
    const project = makeProject();
    const activeMilestone = project.milestones[1];
    const activeTask = activeMilestone.microtasks[0];

    const brief = buildInstructorRuntimeBrief(project, activeMilestone, activeTask);

    expect(brief).toContain('Build a HashMap Playground');
    expect(brief).toContain('Learn HashMap operations');
    expect(brief).toContain(
      'Current location: milestone 1 "Model the core HashMap behavior", microtask 2/2 "Implement lookup"',
    );
    expect(brief).toContain('(2) Implement lookup [in progress');
    expect(brief).toContain('Task intent: Use a key to find the right bucket');
    expect(brief).toContain('Milestone 2: Wire the interactive demo [locked]');
    expect(brief).toContain('latest submission is newer than the latest task evaluation');
    expect(brief).toContain('right-side submission panel');
    expect(brief).toContain('Continue button');
    expect(brief).toContain('Pending stage handover');
  });

  it('instructs the LLM to drive difficulty changes via the adjust_difficulty tool (sole mechanism, no regex)', () => {
    // There is no longer any per-message regex detector for learner difficulty
    // requests — the runtime brief is what makes the LLM call adjust_difficulty,
    // so this guards that the contract is present and unambiguous.
    const project = makeProject();
    const activeMilestone = project.milestones[1];
    const activeTask = activeMilestone.microtasks[0];

    const brief = buildInstructorRuntimeBrief(project, activeMilestone, activeTask);

    expect(brief).toContain('adjust_difficulty');
    expect(brief).toMatch(/EVERY learner message/i);
    expect(brief).toMatch(/ONLY way difficulty changes/i);
    // Must instruct SEMANTIC judgement, not keyword / fixed-pattern matching.
    expect(brief).toMatch(/by MEANING — not by keywords/i);
  });

  it('treats the right-side submission panel as the only readiness path', () => {
    const project = makeProject();
    const milestone = project.milestones[1]; // ms-1
    const noSubmissionTask = milestone.microtasks.find((t) => t.id === 'mt-1')!; // 0 submissions
    const brief = buildInstructorRuntimeBrief(project, milestone, noSubmissionTask);

    expect(brief).toContain('task readiness comes only from work submitted and evaluated');
    expect(brief).toContain('right-side submission panel is REQUIRED');
    expect(brief).toContain('Do not say that chat alone completed the task');

    expect(brief).not.toContain('right-side submission panel is OPTIONAL');
    expect(brief).not.toContain('completed directly in the chat');
    expect(brief).not.toContain('do not route them to the panel');
  });

  it('does not reorder the project while building the prompt context', () => {
    const project = makeProject();
    const milestoneOrderBefore = project.milestones.map((m) => m.id);
    const taskOrderBefore = project.milestones[1].microtasks.map((t) => t.id);

    buildInstructorRuntimeBrief(
      project,
      project.milestones[1],
      project.milestones[1].microtasks[0],
    );

    expect(project.milestones.map((m) => m.id)).toEqual(milestoneOrderBefore);
    expect(project.milestones[1].microtasks.map((t) => t.id)).toEqual(taskOrderBefore);
  });
});

describe('PBL v2 — first-task workspace orientation', () => {
  function firstTaskProject(): PBLProjectV2 {
    const project = makeProject();
    project.milestones[1].microtasks[0].status = 'todo';
    project.milestones[1].microtasks[1].status = 'in_progress';
    return project;
  }

  it('adds workspace usage guidance for the first milestone first task in open-task phases', () => {
    const project = firstTaskProject();
    const milestone = project.milestones[1]; // order 0
    const microtask = milestone.microtasks.find((t) => t.id === 'mt-1')!; // order 0

    const block = buildFirstTaskWorkspaceOrientationBlock({
      project,
      milestone,
      microtask,
      phase: 'greeting',
    });

    expect(block).toContain('First-task workspace orientation');
    expect(block).toContain('left side is the task sidebar');
    expect(block).toContain('center is the Instructor interaction area');
    expect(block).toContain('right side');
    expect(block).toContain('final deliverable should be submitted on the right');
    expect(block).toContain('copying/pasting text');
    expect(block).toContain('PDF or an image/screenshot');
    expect(block).toContain('feedback card');
    expect(block).toContain('click the button that appears to advance');
    expect(block).toContain('ask and discuss anything with the Instructor');
  });

  it('does not add the orientation for later tasks or normal instructing turns', () => {
    const project = makeProject();
    const milestone = project.milestones[1];
    const laterTask = milestone.microtasks.find((t) => t.id === 'mt-2')!;

    expect(
      buildFirstTaskWorkspaceOrientationBlock({
        project,
        milestone,
        microtask: laterTask,
        phase: 'setup',
      }),
    ).toBe('');

    const firstTask = milestone.microtasks.find((t) => t.id === 'mt-1')!;
    expect(
      buildFirstTaskWorkspaceOrientationBlock({
        project,
        milestone,
        microtask: firstTask,
        phase: 'instructing',
      }),
    ).toBe('');
  });

  it('NEVER adds the ordinary workspace orientation to a scenario project (it has its own prep briefing)', () => {
    const project = makeProject();
    // make it a scenario project; first milestone first task, greeting phase —
    // the exact condition that would fire the orientation for an ordinary project.
    project.scenario = {
      setting: 's',
      characters: [{ id: 'c1', name: '小皮', persona: 'p', situation: 'x' }],
    } as PBLProjectV2['scenario'];
    project.milestones[0].scenarioStage = 'prep';
    const milestone = project.milestones[0];
    const microtask = milestone.microtasks[0];
    expect(
      buildFirstTaskWorkspaceOrientationBlock({ project, milestone, microtask, phase: 'greeting' }),
    ).toBe('');
  });
});

describe('PBL v2 — Instructor advance handoff text cleanup', () => {
  it('dedupes an accidental repeated old-task wrap-up sentence', () => {
    const result = cleanInstructorCommitText(
      '对，这三行已经满足本步要求：print() 在 if 里面，只有 has_card 为 True 时才会输出“可以进门”。对，这三行已经满足本步要求：print() 在 if 里面，只有 has_card 为 True 时才会输出“可以进门”。',
    );

    expect(result.changed).toBe(true);
    expect(result.text).toBe(
      '对，这三行已经满足本步要求：print() 在 if 里面，只有 has_card 为 True 时才会输出“可以进门”。',
    );
  });

  it('removes leaked observation tool JSON from committed instructor text', () => {
    const result = stripLeakedToolJson(
      '{"kind":"concept_unlocked","note":"学习者提交了 print(left_money)，正确用 print 输出了剩余金额变量。","signature":"print_left_money_output"}可以，这一步已经能把剩余金额显示出来了。',
    );

    expect(result.changed).toBe(true);
    expect(result.text).toBe('可以，这一步已经能把剩余金额显示出来了。');
  });

  it('wires next-task cleanup into committed instructor text when context is provided', () => {
    const result = cleanInstructorCommitText(
      [
        '很好，你已经验证了值传递为什么不会改变原变量。',
        '',
        '现在进入第三步：运行程序并观察值传递的局限。我们先运行一次，看看输出。',
      ].join('\n'),
      { nextMicrotaskTitle: '运行程序并观察值传递的局限' },
    );

    expect(result.changed).toBe(true);
    expect(result.text).toBe('很好，你已经验证了值传递为什么不会改变原变量。');
  });

  it('does not strip transition language from generic committed text without next-task context', () => {
    const text = '下一步我们把代码运行一次，看看终端输出是否符合预期。';
    expect(cleanInstructorCommitText(text)).toEqual({ text, changed: false });
  });

  it('keeps normal teaching questions unless the commit context asks for statement-only text', () => {
    const text = '你觉得 input() 返回的是什么类型呢？';
    expect(cleanInstructorCommitText(text)).toEqual({ text, changed: false });
    expect(cleanInstructorCommitText(text, { stripFinalReverseQuestion: true })).toEqual({
      text,
      changed: false,
    });
  });

  it('removes orphan final reverse-questions for statement-only commits', () => {
    const result = cleanInstructorCommitText(
      '很好，你已经让程序正确输出了问候。input() 拿到的内容为什么要先存进变量再用呢？',
      { stripFinalReverseQuestion: true },
    );

    expect(result.changed).toBe(true);
    expect(result.text).toBe('很好，你已经让程序正确输出了问候。');
  });

  it('keeps the old-task wrap-up and removes a same-message next-task opener', () => {
    const result = stripPrematureNextTaskSetup(
      [
        '很好，你已经验证了值传递为什么不会改变原变量。',
        '',
        '现在进入第三步：运行程序并观察值传递的局限。我们先运行一次，看看输出。',
      ].join('\n'),
      '运行程序并观察值传递的局限',
    );

    expect(result.stripped).toBe(true);
    expect(result.text).toBe('很好，你已经验证了值传递为什么不会改变原变量。');
  });

  it('leaves normal old-task feedback unchanged when it does not open the next task', () => {
    const text = '很好，这一步你已经能说清楚 swap(a, b) 为什么只改了副本。';
    const result = stripPrematureNextTaskSetup(text, '运行程序并观察值传递的局限');

    expect(result).toEqual({ text, stripped: false });
  });

  it('also removes a clear next-task transition even when the title is paraphrased', () => {
    const result = stripPrematureNextTaskSetup(
      '你的解释是对的：值传递只改了函数里的副本。\n\n下一步我们开始做指针版本，先把函数参数改成地址。',
      '编写指针版本的swap函数',
    );

    expect(result.stripped).toBe(true);
    expect(result.text).toBe('你的解释是对的：值传递只改了函数里的副本。');
  });

  it('removes cross-milestone Continue guidance from the old-task wrap-up', () => {
    const result = stripPrematureNextTaskSetup(
      '这一阶段你已经把添加和展示清单跑通了。\n\n下一阶段我们会给清单加上"删除"功能——点击右侧的 Continue 按钮继续吧 👉',
      undefined,
      '实现删除功能',
    );

    expect(result.stripped).toBe(true);
    expect(result.text).toBe('这一阶段你已经把添加和展示清单跑通了。');
  });

  it('removes previous-task praise from a setup opener after the divider', () => {
    const result = cleanSetupFollowupText(
      '很好，if 这一行已经像门禁机的“判断入口”了；现在我们要把判断成立时真正发生的事放进去。\n\n这一步的计划很简单：在 if has_card: 的下一行缩进 4 个空格，然后写一行 print()。',
    );

    expect(result.changed).toBe(true);
    expect(result.text).toBe(
      '现在我们要把判断成立时真正发生的事放进去。\n\n这一步的计划很简单：在 if has_card: 的下一行缩进 4 个空格，然后写一行 print()。',
    );
  });

  it('removes vague setup lead-ins so the next action is explicit', () => {
    const result = cleanSetupFollowupText(
      '很接近第一个可运行成果了；这一步的意义是确认代码不只是“看起来对”，而是真的能在屏幕上产生预期输出。\n\n按这个小计划来：保持 has_card = True 不变，运行当前 Python 文件，然后看终端里是否出现“可以进门”。',
    );

    expect(result.changed).toBe(true);
    expect(result.text).toBe(
      '这一步的意义是确认代码不只是“看起来对”，而是真的能在屏幕上产生预期输出。\n\n保持 has_card = True 不变，运行当前 Python 文件，然后看终端里是否出现“可以进门”。',
    );
  });

  it('holds early setup-followup tokens that still look like previous-task praise', () => {
    const raw = '很好，上一任务已经完成得很稳';
    expect(shouldHoldSetupFollowupPreview(raw, cleanSetupFollowupText(raw))).toBe(true);
  });

  it('releases setup-followup streaming once the cleaned next-task opener is available', () => {
    const raw = '很好，上一任务已经完成得很稳；现在我们要读取用户输入的温度。';
    const cleaned = cleanSetupFollowupText(raw);
    expect(cleaned.changed).toBe(true);
    expect(shouldHoldSetupFollowupPreview(raw, cleaned)).toBe(false);
    expect(cleaned.text).toBe('现在我们要读取用户输入的温度。');
  });
});

describe('PBL v2 — orphan trailing reverse-question cleanup', () => {
  it('removes a trailing reverse-question sentence after the review', () => {
    const result = stripOrphanTrailingQuestion(
      '很好，你已经让程序正确输出了问候。input() 拿到的内容为什么要先存进变量再用呢？',
    );
    expect(result.changed).toBe(true);
    expect(result.text).toBe('很好，你已经让程序正确输出了问候。');
  });

  it('cuts an explicit closing lead-in even when comma-joined to the praise', () => {
    const result = stripOrphanTrailingQuestion(
      '很好，你已经正确输出了问候，最后确认一下 input() 为什么要存进变量呢？',
    );
    expect(result.changed).toBe(true);
    expect(result.text).toBe('很好，你已经正确输出了问候');
  });

  it('handles an English trailing question', () => {
    const result = stripOrphanTrailingQuestion(
      'Nice, your script greets the user. In your own words, why did we store input() in a variable?',
    );
    expect(result.changed).toBe(true);
    expect(result.text).toBe('Nice, your script greets the user.');
  });

  it('leaves a statement-only message unchanged', () => {
    const text = '很好，你已经正确输出了问候，方向完全对。';
    const result = stripOrphanTrailingQuestion(text);
    expect(result).toEqual({ text, changed: false });
  });

  it('never blanks a message that is only a single question', () => {
    const text = '你觉得 input() 返回的是什么类型呢？';
    const result = stripOrphanTrailingQuestion(text);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(text);
  });

  it('peels multiple trailing question sentences but keeps the review', () => {
    const result = stripOrphanTrailingQuestion(
      '对，循环跑通了。你觉得 range() 的上界为什么不包含自己？再想想 step 是怎么回事？',
    );
    expect(result.changed).toBe(true);
    expect(result.text).toBe('对，循环跑通了。');
  });

  it('P3: does not mis-cut a version/decimal number into a fragment', () => {
    const result = stripOrphanTrailingQuestion('装好了，你用了 v2.0 对吧？');
    expect(result.changed).toBe(false);
    expect(result.text).toBe('装好了，你用了 v2.0 对吧？');
  });

  it('P3: an English decimal is not treated as a sentence boundary', () => {
    const result = stripOrphanTrailingQuestion('You set version 2.5 already?');
    expect(result.changed).toBe(false);
    expect(result.text).toBe('You set version 2.5 already?');
  });

  it('P3: cuts at the sentence boundary before a lead-in (no dangling connector)', () => {
    const result = stripOrphanTrailingQuestion(
      '很好，程序跑起来了。我们最后看一下，为什么要先读输入呢？',
    );
    expect(result.changed).toBe(true);
    expect(result.text).toBe('很好，程序跑起来了。');
  });

  it('P3: trims a dangling connector when a lead-in is comma+connector fused', () => {
    const result = stripOrphanTrailingQuestion('不错，那我们最后确认一下为什么？');
    expect(result.changed).toBe(true);
    expect(result.text).toBe('不错');
  });
});

describe('PBL v2 — stage synthesis checkpoint gate', () => {
  it('is not owed when the milestone has no synthesisCheck', () => {
    const project = makeProject();
    const ms = project.milestones[1]; // ms-1, active
    const lastTask = ms.microtasks.find((t) => t.id === 'mt-2')!;
    expect(stageSynthesisOwed(project, ms, lastTask)).toBe(false);
  });

  it('is owed on the last microtask of a core (synthesisCheck) stage', () => {
    const project = makeProject();
    const ms = project.milestones[1]; // ms-1: mt-1 completed, mt-2 in_progress
    ms.synthesisCheck = { coreConcept: '为什么用哈希能 O(1) 查找' };
    const lastTask = ms.microtasks.find((t) => t.id === 'mt-2')!;
    expect(stageSynthesisOwed(project, ms, lastTask)).toBe(true);
  });

  it('is NOT owed when the microtask is not the last of the core stage', () => {
    const project = makeProject();
    const ms = project.milestones[1];
    ms.synthesisCheck = { coreConcept: '哈希查找' };
    // Add a still-open sibling so mt-2 is no longer the last.
    ms.microtasks.push({
      id: 'mt-extra',
      title: 'Extra step',
      status: 'todo',
      assignee: 'user',
      hints: [],
      order: 2,
    });
    const midTask = ms.microtasks.find((t) => t.id === 'mt-2')!;
    expect(stageSynthesisOwed(project, ms, midTask)).toBe(false);
  });

  it('clears the gate once a stage_synthesis_check is recorded', () => {
    const project = makeProject();
    const ms = project.milestones[1];
    ms.synthesisCheck = { coreConcept: '哈希查找' };
    const lastTask = ms.microtasks.find((t) => t.id === 'mt-2')!;

    expect(milestoneSynthesisSatisfied(project, ms.id)).toBe(false);
    expect(stageSynthesisOwed(project, ms, lastTask)).toBe(true);

    recordEvent(project, 'stage_synthesis_check', {
      microtaskId: lastTask.id,
      milestoneId: ms.id,
      payload: {
        question: '回看整个阶段，哈希为什么能让查找变快？',
        learner_answer: '因为用 key 直接算出桶位置，不用一个个找。',
        quality: 'strong',
      },
    });

    expect(milestoneSynthesisSatisfied(project, ms.id)).toBe(true);
    expect(stageSynthesisOwed(project, ms, lastTask)).toBe(false);
  });

  it('absorbs the microtask closing gate: a stage_synthesis_check sets the closing fields', () => {
    const project = makeProject();
    const ms = project.milestones[1];
    const lastTask = ms.microtasks.find((t) => t.id === 'mt-2')!;
    recordEvent(project, 'stage_synthesis_check', {
      microtaskId: lastTask.id,
      milestoneId: ms.id,
      payload: {
        question: '整个阶段你怎么总结？',
        learner_answer: 'key→hash→bucket→value。',
        quality: 'ok',
      },
    });
    const summary = microtaskEngagement(project, lastTask.id);
    expect(summary.closingQuestion).toBe('整个阶段你怎么总结？');
    expect(summary.closingAnswer).toBe('key→hash→bucket→value。');
    expect(summary.closingQuality).toBe('ok');
  });

  it('P2b: gate also accepts a closing_check on the last microtask (wrong-tool robustness)', () => {
    const project = makeProject();
    const ms = project.milestones[1]; // last microtask by order is mt-2
    expect(milestoneSynthesisSatisfied(project, ms.id)).toBe(false);
    recordEvent(project, 'closing_check', {
      microtaskId: 'mt-2',
      milestoneId: ms.id,
      payload: { question: '为什么查找快？', learner_answer: '直接算桶位置。', quality: 'ok' },
    });
    expect(milestoneSynthesisSatisfied(project, ms.id)).toBe(true);
  });

  it('P2b: a closing_check on a NON-last microtask does not satisfy the gate', () => {
    const project = makeProject();
    const ms = project.milestones[1];
    recordEvent(project, 'closing_check', {
      microtaskId: 'mt-1', // completed, order 0 — not the last
      milestoneId: ms.id,
      payload: { question: 'q', learner_answer: 'a', quality: 'ok' },
    });
    expect(milestoneSynthesisSatisfied(project, ms.id)).toBe(false);
  });
});

describe('PBL v2 — instructor sees earlier submissions across the project (#519)', () => {
  it('digests an earlier task submission with how it was assessed', () => {
    const project = makeProject();
    // Make the evaluation NEWER than the submission so it is genuinely this
    // submission's assessment (the fixture default has an older eval — see the
    // stale-eval test below).
    project.evaluations[0].createdAt = '2026-05-29T00:15:00.000Z';
    // Active = mt-1 (no submission). mt-2 carries the only submission + eval.
    const block = buildPriorSubmissionsBlock(project, 'mt-1');
    expect(block).toContain('Model the core HashMap behavior / Implement lookup');
    expect(block).toContain('handled missing keys with undefined'); // the submitted content
    expect(block).toContain('score 70'); // how it was assessed
    expect(block).toContain('to improve: Check missing keys');
  });

  it('does not borrow a stale score when the latest submission postdates the eval', () => {
    // Fixture: submission at 00:10, evaluation at 00:05 → the learner has a
    // newer, not-yet-evaluated version. The Instructor must NOT be told it
    // "scored 70" (that score belongs to a previous version).
    const project = makeProject();
    const block = buildPriorSubmissionsBlock(project, 'mt-1');
    expect(block).toContain('latest version not yet evaluated');
    expect(block).not.toContain('score 70');
  });

  it('marks an earlier submission with no evaluation as not yet scored', () => {
    const project = makeProject();
    project.evaluations = [];
    const block = buildPriorSubmissionsBlock(project, 'mt-1');
    expect(block).toContain('not yet scored');
    expect(block).not.toContain('score 70');
  });

  it("excludes the active task's own submission (no duplication of the current task)", () => {
    const project = makeProject();
    // mt-2 is the only task with a submission; when it is ACTIVE the prior
    // block has nothing left to show.
    expect(buildPriorSubmissionsBlock(project, 'mt-2')).toBe('');
  });

  it('returns empty when there are no submissions at all', () => {
    const project = makeProject();
    project.submissions = [];
    expect(buildPriorSubmissionsBlock(project, 'mt-1')).toBe('');
  });

  it('drops entries that do not fit the budget and marks truncation', () => {
    const project = makeProject();
    const block = buildPriorSubmissionsBlock(project, 'mt-1', { maxChars: 200 });
    expect(block).toContain('truncated to keep context bounded');
    expect(block).not.toContain('handled missing keys with undefined');
  });
});

describe('PBL v2 — scaffolding state release verdict (P2 ①②)', () => {
  const base = {
    learnerTurnCount: 1,
    errorCount: 0,
    repeatErrorCount: 0,
    struggles: [] as string[],
    questionsRaised: 0,
    conceptsUnlocked: [] as string[],
  };

  it('HOLDs on the first attempt for a beginner', () => {
    const line = buildScaffoldStateLine({ ...base }, { tier: 'beginner', submissionCount: 0 });
    expect(line).toContain('HOLD');
  });

  it('RELEASEs for a beginner after one stuck signal (repeat error)', () => {
    const line = buildScaffoldStateLine(
      { ...base, errorCount: 1, repeatErrorCount: 1 },
      { tier: 'beginner', submissionCount: 0 },
    );
    expect(line).toContain('RELEASE');
  });

  it('requires two units before RELEASE at intermediate', () => {
    const one = buildScaffoldStateLine(
      { ...base, struggles: ['s1'] },
      { tier: 'intermediate', submissionCount: 0 },
    );
    expect(one).toContain('HOLD');
    const two = buildScaffoldStateLine(
      { ...base, struggles: ['s1', 's2'] },
      { tier: 'intermediate', submissionCount: 0 },
    );
    expect(two).toContain('RELEASE');
  });

  it('counts genuine attempts (errors+submissions), not raw message count', () => {
    // 5 chatty turns, zero real attempts → still HOLD for a beginner.
    const line = buildScaffoldStateLine(
      { ...base, learnerTurnCount: 5 },
      { tier: 'beginner', submissionCount: 0 },
    );
    expect(line).toContain('HOLD');
  });

  it('treats a second genuine attempt as a release unit', () => {
    const line = buildScaffoldStateLine(
      { ...base, errorCount: 2 },
      { tier: 'beginner', submissionCount: 0 },
    );
    expect(line).toContain('RELEASE');
  });

  it('suppressVerdict drops the verdict + instruction but keeps stats', () => {
    const line = buildScaffoldStateLine(
      { ...base, errorCount: 1, repeatErrorCount: 1 },
      { tier: 'beginner', submissionCount: 0, suppressVerdict: true },
    );
    expect(line).not.toContain('RELEASE');
    expect(line).not.toContain('HOLD');
    expect(line).toContain('genuine attempts');
    expect(line).toContain('stuck signals');
  });

  it('suppressVerdict keeps stats even when release would fire', () => {
    // Same input that would trigger RELEASE without suppress — with
    // suppress the verdict is absent but the data line is intact.
    const line = buildScaffoldStateLine(
      { ...base, errorCount: 1, repeatErrorCount: 1 },
      { tier: 'beginner', submissionCount: 0, suppressVerdict: true },
    );
    expect(line).toContain('## Scaffolding state');
    expect(line).toContain('learner messages');
    expect(line).not.toMatch(/RELEASE|HOLD/);
  });

  it('treats an empty/unset tier as the no-evidence default (intermediate), not beginner', () => {
    // Guards the DEFAULT_TIER consistency gap: the tier-guidance block already
    // resolves '' → intermediate, so the scaffold label + release threshold
    // must match (otherwise the prompt shows intermediate guidance + beginner
    // disclosure ladder simultaneously).
    const unset = buildScaffoldStateLine({ ...base }, { tier: '', submissionCount: 0 });
    expect(unset).toContain('tier intermediate');
    expect(unset).not.toContain('tier beginner');
    // Empty tier must use the intermediate release threshold (2 units): one
    // stuck signal HOLDs (a beginner would RELEASE here).
    const oneSignal = buildScaffoldStateLine(
      { ...base, struggles: ['s1'] },
      { tier: '', submissionCount: 0 },
    );
    expect(oneSignal).toContain('HOLD');
    expect(oneSignal).toContain('L3 after 2 unit');
  });
});

describe('PBL v2 — shouldReportEmptyOutput (suppress only on real user-perceivable output)', () => {
  // Reviewer finding (#593): the old predicate suppressed the empty-output
  // error whenever ANY tool ran (`toolCalled`). That was too broad — a
  // tool *call* is not the same as a user-perceivable result. A turn that
  // only called an internal tool with no text can leave the learner with total
  // silence. The predicate now keys off genuine user-perceivable output:
  // scenario auto-completion (mainTurnAdvanced), committed text, or the
  // difficulty ack (producedAck).
  it('reports the empty-output error on a genuinely empty turn: no text, no advance, no ack', () => {
    expect(
      shouldReportEmptyOutput({
        mainTurnAdvanced: false,
        assistantText: '   ',
        producedAck: false,
      }),
    ).toBe(true);
  });

  it('reports empty output when a tool ran but produced NO user-perceivable result', () => {
    // This is the reviewer case the old code wrongly suppressed: a bare
    // internal tool call with no text, no scenario auto-completion, no ack →
    // the learner saw nothing, so the retry fallback MUST fire.
    expect(
      shouldReportEmptyOutput({
        mainTurnAdvanced: false,
        assistantText: '',
        producedAck: false,
      }),
    ).toBe(true);
  });

  it('does NOT report empty output when the turn produced scenario auto-completion', () => {
    expect(
      shouldReportEmptyOutput({
        mainTurnAdvanced: true,
        assistantText: '',
        producedAck: false,
      }),
    ).toBe(false);
  });

  it('does NOT report empty output when a difficulty ack was committed', () => {
    expect(
      shouldReportEmptyOutput({
        mainTurnAdvanced: false,
        assistantText: '',
        producedAck: true,
      }),
    ).toBe(false);
  });

  it('does NOT report empty output when committed text exists', () => {
    expect(
      shouldReportEmptyOutput({
        mainTurnAdvanced: false,
        assistantText: '好的，我们换个角度来讲。',
        producedAck: false,
      }),
    ).toBe(false);
  });
});

describe('PBL v2 — Instructor model message guard', () => {
  it('adds a user anchor when history is empty', () => {
    expect(ensureNonEmptyInstructorMessages([], '请介绍项目')).toEqual([
      { role: 'user', content: '请介绍项目' },
    ]);
  });

  it('keeps valid conversation history and trims blank content', () => {
    expect(
      ensureNonEmptyInstructorMessages(
        [
          { role: 'user', content: ' 你好 ' },
          { role: 'assistant', content: ' 好的 ' },
          { role: 'user', content: '   ' },
        ],
        'fallback',
      ),
    ).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '好的' },
    ]);
  });

  it('keeps memory but still adds a user anchor when only system memory exists', () => {
    expect(
      ensureNonEmptyInstructorMessages(
        [{ role: 'system', content: 'Earlier conversation memory' }],
        '继续当前任务',
      ),
    ).toEqual([
      { role: 'system', content: 'Earlier conversation memory' },
      { role: 'user', content: '继续当前任务' },
    ]);
  });
});

describe('PBL v2 — Instructor scenario awareness block (Increment 2)', () => {
  // A coherent scenario project: fixed prep → scene → wrapup skeleton.
  function scenarioProject(): PBLProjectV2 {
    const p = makeProject();
    p.scenario = {
      setting: '校园咖啡馆的午后',
      goal: '练习倾听与共情',
      characters: [
        {
          id: 'char-1',
          name: '林夏',
          persona: '内向的同学，说话轻声细语',
          situation: '这周失恋，情绪低落',
        },
      ],
    };
    p.schemaVersion = 1;
    p.milestones = [
      milestone({
        id: 'ms-prep',
        title: '准备',
        order: 0,
        status: 'active',
        scenarioStage: 'prep',
      }),
      milestone({ id: 'ms-scene', title: '和林夏聊一聊', order: 1, scenarioStage: 'roleplay' }),
      milestone({ id: 'ms-wrap', title: '收尾', order: 2, scenarioStage: 'wrapup' }),
    ];
    return p;
  }

  const prepOf = (p: PBLProjectV2) => p.milestones.find((m) => m.scenarioStage === 'prep')!;
  const sceneOf = (p: PBLProjectV2) => p.milestones.find((m) => m.scenarioStage === 'roleplay')!;
  const wrapOf = (p: PBLProjectV2) => p.milestones.find((m) => m.scenarioStage === 'wrapup')!;

  it('returns empty string for an ordinary (non-scenario) project', () => {
    expect(
      buildScenarioAwarenessBlock({
        project: makeProject(),
        milestone: makeProject().milestones[0],
        phase: 'greeting',
      }),
    ).toBe('');
  });

  it('mentions setting, character (with situation), goal and scene stage', () => {
    const p = scenarioProject();
    const block = buildScenarioAwarenessBlock({
      project: p,
      milestone: prepOf(p),
      phase: 'greeting',
    });
    expect(block).toContain('校园咖啡馆的午后');
    expect(block).toContain('林夏');
    expect(block).toContain('这周失恋，情绪低落');
    expect(block).toContain('和林夏聊一聊');
    expect(block).toContain('练习倾听与共情');
  });

  it('prep GREETING: specs the full structured opening briefing (8 parts + markdown + sidebar CTA, no impersonation)', () => {
    const p = scenarioProject();
    const block = buildScenarioAwarenessBlock({
      project: p,
      milestone: prepOf(p),
      phase: 'greeting',
    });
    expect(block).toContain('write the OPENING briefing');
    expect(block).toContain('LEFT sidebar');
    // a couple of the mandatory parts
    expect(block).toContain('warm greeting');
    expect(block).toContain('self-introduction');
    expect(block).toMatch(/not.*impersonate/i);
    // Formatting stability fix: the briefing must explicitly OVERRIDE the global
    // brevity / "don't format like a form" rules and make rich formatting a hard
    // requirement, so the opener doesn't randomly collapse into a flat paragraph.
    expect(block).toMatch(/EXCEPTION to the global brevity rules/i);
    expect(block).toMatch(/Formatting is MANDATORY/i);
    expect(block).toMatch(/section heading/i);
    expect(block).toMatch(/bullet points/i);
    expect(block).toMatch(/paragraph-only opening .* is WRONG/i);
    // Prep gives the learner nothing to DO — no task / warm-up / quiz, and no
    // question that expects an answer (only inviting THEM to ask the coach).
    expect(block).toMatch(/Do NOT set any task, warm-up, mini-exercise, or quiz/i);
    expect(block).toMatch(/End on part 8/i);
  });

  it('prep GREETING with scenario.rules: REQUIRES a rules section that teaches the rules', () => {
    const p = scenarioProject();
    p.scenario!.rules = '6 人局；翻前/翻后下注；牌型大小；Pot Odds 的含义';
    const block = buildScenarioAwarenessBlock({
      project: p,
      milestone: prepOf(p),
      phase: 'greeting',
    });
    expect(block).toMatch(/Rules — REQUIRED/i);
    expect(block).toMatch(/bullet points/i);
    // does NOT carry the "no special rule-set" escape hatch
    expect(block).not.toMatch(/no special rule-set/i);
  });

  it('prep GREETING without scenario.rules: forbids inventing rules (e.g. comfort-a-friend)', () => {
    const p = scenarioProject();
    expect(p.scenario!.rules).toBeUndefined();
    const block = buildScenarioAwarenessBlock({
      project: p,
      milestone: prepOf(p),
      phase: 'greeting',
    });
    expect(block).toMatch(/no special rule-set/i);
    expect(block).not.toMatch(/Rules — REQUIRED/i);
  });

  it('prep INSTRUCTING (follow-up): answer only, cannot advance, no impersonation', () => {
    const p = scenarioProject();
    const block = buildScenarioAwarenessBlock({
      project: p,
      milestone: prepOf(p),
      phase: 'instructing',
    });
    expect(block).toContain('answering a follow-up');
    expect(block).toMatch(/cannot.*advance/i);
    expect(block).toMatch(/not.*impersonate/i);
  });

  it('wrapup stage: grounds the debrief in the real transcript; auto-closing, no confirm, no questions', () => {
    const p = scenarioProject();
    const block = buildScenarioAwarenessBlock({
      project: p,
      milestone: wrapOf(p),
      phase: 'instructing',
    });
    expect(block).toContain('WRAPUP stage');
    expect(block).toMatch(/light/i);
    // Grounded in what actually happened (the role-play transcript), not invented.
    expect(block).toMatch(/What actually happened in the scene/i);
    expect(block).toMatch(/never invent/i);
    // The session auto-completes — the instructor must not ask the learner to
    // confirm / reply / click, and must not ask ANY question.
    expect(block).toMatch(/session ENDS automatically/i);
    expect(block).toMatch(/Do NOT ask the learner ANY question/i);
    expect(block).toMatch(/Do NOT request a reply, confirmation/i);
    // Explicit override of the reused teaching rules (so "ask a question / hand
    // off the next action" cannot leak into a terminal summary).
    expect(block).toMatch(/EXCEPTION to the teaching rules/i);
    expect(block).toMatch(/NO next task/i);
  });

  it('scene stage: tells the instructor the scene is handed off + do not impersonate', () => {
    const p = scenarioProject();
    const block = buildScenarioAwarenessBlock({
      project: p,
      milestone: sceneOf(p),
      phase: 'instructing',
    });
    expect(block).toContain('handed off');
    expect(block).toMatch(/not.*impersonate/i);
  });

  it('degrades to empty when scenario has a cast but no scene stage', () => {
    const p = scenarioProject();
    p.milestones = p.milestones.map((m) => ({ ...m, scenarioStage: undefined }));
    expect(
      buildScenarioAwarenessBlock({ project: p, milestone: p.milestones[0], phase: 'greeting' }),
    ).toBe('');
  });

  it('degrades to empty when scenario has no characters', () => {
    const p = scenarioProject();
    p.scenario!.characters = [];
    expect(
      buildScenarioAwarenessBlock({ project: p, milestone: p.milestones[0], phase: 'greeting' }),
    ).toBe('');
  });
});
