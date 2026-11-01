import { describe, expect, it } from 'vitest';
import {
  LONG_FORM_MAX_MINUTES,
  LONG_FORM_MIN_MINUTES,
  MAX_SCENE_SECONDS,
  MIN_SCENE_SECONDS,
  apportion,
  buildLongFormBrief,
  buildSceneBrief,
  detectLongForm,
  detectRequestedMinutes,
  enforceBounds,
  formatClock,
  inferPlanLanguage,
  locateScene,
  moduleAtPage,
  planForRequirement,
  planLongFormCourse,
  speechBudgetFor,
} from '@/lib/generation/long-form';

describe('detectRequestedMinutes', () => {
  it('reads the unit the request actually names', () => {
    expect(detectRequestedMinutes('做一个 60 分钟的中医基础理论课')).toBe(60);
    expect(detectRequestedMinutes('我要一节 1 小时的课')).toBe(60);
    expect(detectRequestedMinutes('build me a 1.5 hour lecture')).toBe(90);
    expect(detectRequestedMinutes('a 45-min lesson on recursion')).toBe(45);
  });

  it('does not read a clock time as a length', () => {
    // A stray "第 3 分钟" reads as three minutes. Harmless: it is far below the
    // long-form threshold, so the flat path keeps the request either way.
    expect(detectRequestedMinutes('讲解第 3 分钟出现的心电图异常')).toBe(3);
    expect(detectLongForm('讲解第 3 分钟出现的心电图异常').isLongForm).toBe(false);
  });

  it('refuses an hour figure longer than a single sitting', () => {
    // "为什么睡 12 小时还是累" is a lesson about sleep, not a twelve-hour course.
    expect(detectRequestedMinutes('what happens at 12 hours of sleep deprivation')).toBeNull();
    expect(detectRequestedMinutes('睡 12 小时还是累的原因')).toBeNull();
  });

  it('returns null when no duration is named', () => {
    expect(detectRequestedMinutes('teach me photosynthesis')).toBeNull();
    expect(detectRequestedMinutes('')).toBeNull();
  });

  it('sums a compound hour-and-minute phrase', () => {
    // Reading only the hours returns 60 for a request that asked for 90.
    expect(detectRequestedMinutes('一节 1 小时 30 分钟的课')).toBe(90);
    expect(detectRequestedMinutes('a 1 hour 30 minute lecture')).toBe(90);
    expect(detectRequestedMinutes('2 小时 15 分钟的讲座')).toBe(135);
  });

  it('accepts a hyphen between the figure and the unit', () => {
    expect(detectRequestedMinutes('a 2-hour course')).toBe(120);
    expect(detectRequestedMinutes('a 90-minute course')).toBe(90);
  });

  it('refuses a minute figure longer than a single sitting', () => {
    // Clamping to 240 would plan a course an hour shorter than the one asked for
    // with nothing in the output saying so.
    expect(detectRequestedMinutes('a 300-minute course')).toBeNull();
    expect(detectLongForm('a 300-minute course').isLongForm).toBe(false);
  });

  it('reads a duration written in words', () => {
    // `一小时的课程` is the ordinary way to write a length. Reading digits only
    // sent it to the short path, which is the failure this feature prevents.
    expect(detectRequestedMinutes('一小时的课程')).toBe(60);
    expect(detectRequestedMinutes('一个半小时的课')).toBe(90);
    expect(detectRequestedMinutes('半小时的课')).toBe(30);
    expect(detectRequestedMinutes('a one-hour lecture')).toBe(60);
    expect(detectRequestedMinutes('an hour on entropy')).toBe(60);
    expect(detectRequestedMinutes('half an hour on recursion')).toBe(30);
  });

  it('keeps looking when a topical figure is out of range', () => {
    // The hours branch runs first over the whole string; stopping at the first
    // candidate threw away the hour that was actually asked for.
    const mixed = 'Create a 60-minute lesson about why 12 hours of sleep can leave you tired';
    expect(detectRequestedMinutes(mixed)).toBe(60);
    expect(detectLongForm(mixed).isLongForm).toBe(true);
  });

  it('does not read the tail of a rejected compound as its own duration', () => {
    // `a 4 hour 30 minute course` is 270 minutes and unsupported. The minute scan
    // then found the `30 minute` tail and planned a half-hour course out of a
    // four-and-a-half-hour request — a shorter course than either reading.
    expect(detectRequestedMinutes('a 4 hour 30 minute course')).toBeNull();
    expect(detectLongForm('a 4 hour 30 minute course').isLongForm).toBe(false);
    expect(detectRequestedMinutes('一节 5 小时 30 分钟的课')).toBeNull();
  });

  it('picks the figure the sentence frames as the course', () => {
    // Hours used to win outright, and the context test then accepted the result
    // because `course` appeared somewhere — so the phenomenon became the length.
    const topicalFirst = 'Create a course about the 2-hour insulin response lasting 60 minutes';
    expect(detectLongForm(topicalFirst)).toEqual({ isLongForm: true, requestedMinutes: 60 });

    const courseFirst = 'Create a 60-minute course about the 2-hour insulin response';
    expect(detectLongForm(courseFirst)).toEqual({ isLongForm: true, requestedMinutes: 60 });
  });
});

describe('detectLongForm', () => {
  it('splits short lessons from long-form sittings at the threshold', () => {
    expect(detectLongForm('20 分钟的入门课').isLongForm).toBe(false);
    expect(detectLongForm(`${LONG_FORM_MIN_MINUTES} 分钟的课`).isLongForm).toBe(true);
    expect(detectLongForm('60 minutes on entropy').isLongForm).toBe(true);
  });

  it('does not read a topical duration as a sitting', () => {
    // The insulin response lasts thirty minutes; the lesson about it is not
    // thirty minutes long, and handing it the long-form budget plans a course
    // nobody asked for.
    expect(detectLongForm('explain the 30-minute insulin response').isLongForm).toBe(false);
    expect(detectLongForm('30 分钟的胰岛素反应是怎么回事').isLongForm).toBe(false);
    expect(detectLongForm('为什么 40 分钟的午睡醒来更累').isLongForm).toBe(false);
  });

  it('still reads a bare duration that is the whole request', () => {
    expect(detectLongForm('60 分钟').isLongForm).toBe(true);
  });

  it('leaves an unspecified length on the short path', () => {
    expect(detectLongForm('teach me photosynthesis')).toEqual({
      isLongForm: false,
      requestedMinutes: null,
    });
  });
});

describe('apportion', () => {
  it('always sums to the total', () => {
    for (const total of [25, 30, 45, 60, 75, 90, 120, 180, 240]) {
      for (const count of [4, 5, 6, 8, 11, 12]) {
        const parts = apportion(
          total,
          Array.from({ length: count }, () => 1),
        );
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it('gives the leftover minutes to the largest remainders', () => {
    expect(apportion(60, [0.12, 0.24, 0.28, 0.24, 0.12])).toEqual([7, 15, 17, 14, 7]);
  });
});

describe('enforceBounds', () => {
  it('lifts stubs and keeps the total unchanged', () => {
    const result = enforceBounds([3, 9, 10, 3], 6, 20);
    expect(result.reduce((a, b) => a + b, 0)).toBe(25);
    expect(Math.min(...result)).toBeGreaterThanOrEqual(6);
  });

  it('caps an oversized module and hands the surplus on', () => {
    // A four-hour course apportions the hook 12% of 240 minutes: 29 minutes of
    // opening, which no cap was enforcing before.
    const result = enforceBounds([29, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 31], 6, 20);
    expect(result.reduce((a, b) => a + b, 0)).toBe(240);
    expect(Math.max(...result)).toBeLessThanOrEqual(20);
  });

  it('is a no-op when every part is already inside the bounds', () => {
    expect(enforceBounds([7, 9, 10, 8, 8, 10, 8], 6, 20)).toEqual([7, 9, 10, 8, 8, 10, 8]);
  });
});

describe('planLongFormCourse', () => {
  const sixty = planLongFormCourse({ minutes: 60, language: 'zh' });

  it('runs seven teaching moves for an hour', () => {
    // Calibrated against a real 61-minute lesson: 7 multi-page units.
    expect(sixty.modules.map((module) => module.teachingFunction)).toEqual([
      'hook',
      'concept',
      'mechanism',
      'application',
      'concept',
      'mechanism',
      'integration',
    ]);
  });

  it('spends exactly the requested minutes', () => {
    expect(sixty.modules.reduce((acc, module) => acc + module.durationMinutes, 0)).toBe(60);
    expect(sixty.scenes.reduce((acc, scene) => acc + scene.durationSeconds, 0)).toBe(60 * 60);
  });

  it('plans depth per page instead of the flat path scene count', () => {
    expect(sixty.scenes.length).toBe(29);
    expect(sixty.scenes.length).toBeLessThan(40);
    for (const scene of sixty.scenes) {
      expect(scene.durationSeconds).toBeGreaterThanOrEqual(MIN_SCENE_SECONDS);
      expect(scene.durationSeconds).toBeLessThanOrEqual(MAX_SCENE_SECONDS);
    }
  });

  it('budgets speech from the page length, not from a per-scene constant', () => {
    expect(speechBudgetFor(180, 'zh')).toBe(612);
    expect(sixty.totalSpeechBudget).toBe(12_240);
  });

  it('marks module boundaries as attention resets', () => {
    expect(sixty.resetMinutes).toEqual([0, 7, 16, 26, 34, 42, 52]);
  });

  it('ends long enough modules with a retrieval beat', () => {
    const checked = sixty.modules.filter((module) => module.endsWithCheck);
    expect(checked.map((module) => module.index)).toEqual([2, 3, 6]);

    const last = sixty.scenes.filter((scene) => scene.moduleId === 'module_2').at(-1);
    expect(last?.role).toBe('check');
  });

  it('keeps every module a real teaching move', () => {
    for (const modulePlan of sixty.modules) {
      expect(modulePlan.durationMinutes).toBeGreaterThanOrEqual(6);
      expect(modulePlan.sceneBudget).toBeGreaterThanOrEqual(2);
      expect(modulePlan.bridge.length).toBeGreaterThan(0);
    }
  });

  it('leaves teaching pages in a module that also carries a check', () => {
    // A four-page module cannot spend two of them on close + check.
    expect(sixty.scenes.filter((scene) => scene.role === 'check').length).toBe(3);
    const byRole = (role: string) => sixty.scenes.filter((scene) => scene.role === role).length;
    expect(byRole('develop')).toBeGreaterThan(byRole('close'));
    expect(byRole('develop')).toBeGreaterThan(byRole('open'));
  });

  it('is deterministic', () => {
    expect(planLongFormCourse({ minutes: 60, language: 'zh' })).toEqual(sixty);
  });
});

describe('plan obligations', () => {
  const sixty = planLongFormCourse({ minutes: 60, language: 'zh' });

  it('puts a foundation patch on every concept module', () => {
    // Concept modules carry the derivation everything else rests on, so a
    // missing prerequisite there loses the learner for the rest of the course.
    expect(sixty.patchModules).toEqual([2, 5]);
  });

  it('spaces decision points about twenty minutes apart', () => {
    // Six decision quizzes in an hour is a course that is mostly quizzes.
    expect(sixty.decisionModules).toEqual([2, 3, 6]);
    expect(sixty.decisionModules.length).toBeLessThan(sixty.modules.length);
  });

  it('always leaves at least two places to decide, even in a short sitting', () => {
    const short = planLongFormCourse({ minutes: 25, language: 'zh' });
    expect(short.decisionModules.length).toBeGreaterThanOrEqual(2);
    for (const index of short.decisionModules) {
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(short.modules.length);
    }
  });

  it('never asks for a decision in a module too short to hold one', () => {
    // The 8-minute floor is a preference, not a law: a 25-minute sitting has no
    // module that clears it, so its two longest take the decisions compressed.
    for (const minutes of [45, 60, 90, 240]) {
      const plan = planLongFormCourse({ minutes, language: 'zh' });
      for (const index of plan.decisionModules) {
        const owner = plan.modules.find((candidate) => candidate.index === index)!;
        expect(owner.durationMinutes).toBeGreaterThanOrEqual(8);
      }
    }
  });
});

describe('planLongFormCourse across lengths', () => {
  it('handles the shortest long-form sitting without stub modules', () => {
    const plan = planLongFormCourse({ minutes: 25, language: 'zh' });
    expect(plan.minutes).toBe(25);
    expect(plan.modules.reduce((acc, module) => acc + module.durationMinutes, 0)).toBe(25);
    expect(
      Math.min(...plan.modules.map((module) => module.durationMinutes)),
    ).toBeGreaterThanOrEqual(6);
  });

  it('still gives a short long-form course one retrieval beat', () => {
    const plan = planLongFormCourse({ minutes: 25, language: 'zh' });
    expect(plan.modules.filter((module) => module.endsWithCheck).length).toBeGreaterThanOrEqual(1);
  });

  it('runs the middle trio twice past a single sitting and flags it', () => {
    const plan = planLongFormCourse({ minutes: 90, language: 'zh' });
    expect(plan.multiCycle).toBe(true);
    expect(plan.modules.at(-1)?.teachingFunction).toBe('integration');
    expect(plan.modules.reduce((acc, module) => acc + module.durationMinutes, 0)).toBe(90);
  });

  it('never lets a module run past the ceiling, even at four hours', () => {
    const plan = planLongFormCourse({ minutes: 240, language: 'zh' });
    expect(Math.max(...plan.modules.map((module) => module.durationMinutes))).toBeLessThanOrEqual(
      20,
    );
    expect(plan.modules.reduce((acc, module) => acc + module.durationMinutes, 0)).toBe(240);
  });

  it('clamps to the supported range', () => {
    expect(planLongFormCourse({ minutes: 5 }).minutes).toBe(LONG_FORM_MIN_MINUTES);
    expect(planLongFormCourse({ minutes: 900 }).minutes).toBe(LONG_FORM_MAX_MINUTES);
  });

  it('switches speech rate with the teaching language', () => {
    const english = planLongFormCourse({ minutes: 60, language: 'en' });
    expect(english.speechRate).toBe(145);
    expect(english.totalSpeechBudget).toBeLessThan(10_000);
  });
});

describe('locateScene', () => {
  it('finds the module a page belongs to', () => {
    const plan = planLongFormCourse({ minutes: 60, language: 'zh' });
    // Module 1 holds pages 1-3 and module 2 holds 4-7, so page 8 opens module 3.
    const found = locateScene(plan, 8);
    expect(found?.module.index).toBe(3);
    expect(found?.scene.role).toBe('open');
    expect(locateScene(plan, 999)).toBeNull();
  });
});

describe('formatClock', () => {
  it('renders minute offsets as mm:ss', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(23.5)).toBe('23:30');
    expect(formatClock(60)).toBe('60:00');
  });
});

describe('buildLongFormBrief', () => {
  const plan = planLongFormCourse({ minutes: 60, language: 'zh' });
  const brief = buildLongFormBrief(plan);

  it('states the budget the model must respect', () => {
    expect(brief).toContain('HARD REQUIREMENT');
    expect(brief).toContain('29 pages');
    expect(brief).toContain('60 minutes');
    expect(brief).toContain('| 3 | Mechanism derivation |');
  });

  it('names the retrieval modules and the reset marks', () => {
    expect(brief).toContain('Modules 2, 3, 6');
    expect(brief).toContain('00:00, 07:00, 16:00, 26:00, 34:00, 42:00, 52:00');
  });

  it('forbids the flat short-lesson rhythm explicitly', () => {
    expect(brief).toContain('Do NOT return 60 or more pages');
  });

  it('carries the four teaching contracts', () => {
    expect(brief).toContain('The four contracts this course is judged on');
    expect(brief).toContain('**A. Derivation');
    expect(brief).toContain('**B. Systems');
    expect(brief).toContain('**C. Foundation');
    expect(brief).toContain('**D. Agency');
  });

  it('marks which module owes which obligation', () => {
    expect(brief).toContain('| Obligations |');
    // Module 2 is the first concept module: patch + decision.
    expect(brief).toContain('| 2 | Concept construction | concept |');
    expect(brief).toMatch(/\| 2 \| Concept construction \| concept \|[^\n]*\| PD \|/);
    expect(brief).toMatch(/\| 1 \| Problem framing \| hook \|[^\n]*\| — \|/);
  });

  it('tells the model a decision can be the module-end quiz', () => {
    expect(brief).toContain('the decision question **is** that scene');
  });
});

describe('buildSceneBrief', () => {
  const plan = planLongFormCourse({ minutes: 60, language: 'zh' });

  it('tells a middle page where it is', () => {
    const brief = buildSceneBrief({
      plan,
      pageIndex: 8,
      totalPages: 27,
      previousTitle: '半衰期的定义',
      nextTitle: '清除率',
    });

    expect(brief).toContain('Page **8 of 27**');
    expect(brief).toContain('Module **3 of 7**');
    expect(brief).toContain('Narration budget');
    expect(brief).toContain('半衰期的定义');
    expect(brief).toContain('Do not greet the class unless this is page 1');
  });

  it('computes the clock from the outline it was given, not the planned one', () => {
    const brief = buildSceneBrief({ plan, pageIndex: 12, totalPages: 24 });
    // 60 minutes over 24 pages is 2.5 minutes a page: page 12 starts at 27:30.
    expect(brief).toContain('27:30');
    expect(brief).toContain('30:00');
  });

  it('never puts a page outside the module list', () => {
    const brief = buildSceneBrief({ plan, pageIndex: 400, totalPages: 400 });
    expect(brief).toContain('Module **7 of 7**');
  });

  it('gives every module opening its own re-anchor role', () => {
    // "First page opens, last page closes, everything else develops" told every
    // later module's opening page to carry the argument forward — the one thing
    // that page exists not to do.
    const opening = buildSceneBrief({ plan, pageIndex: 4, totalPages: plan.scenes.length });
    expect(opening).toContain('Page role: open');

    const check = buildSceneBrief({ plan, pageIndex: 12, totalPages: plan.scenes.length });
    expect(check).toContain('Page role: check');
  });

  it('uses the planned clock and budget when the page count matches', () => {
    // Equal-width division put page 8 — the exact start of module 3 at 16:00 — at
    // 14:29, and derived its allowance from 124 seconds instead of the slot's 120.
    // Those are the durations the outline was audited against, so the two stages
    // disagreed about the same page.
    const brief = buildSceneBrief({ plan, pageIndex: 8, totalPages: plan.scenes.length });
    expect(brief).toContain('16:00 – 18:00');
    expect(brief).toContain('120s of screen time');

    const slot = plan.scenes[7]!;
    expect(brief).toContain(`about ${slot.speechBudget} characters`);
  });

  it('keeps module roles when the outline drifted', () => {
    // The drift is accepted, so the projected module structure is what the audit
    // checks against. Falling back to "first page opens, last page closes" told
    // page 4 — the opening of module 2 in a 24-page outline — to carry the
    // argument forward instead of re-anchoring.
    const brief = buildSceneBrief({ plan, pageIndex: 4, totalPages: 24 });
    expect(brief).toContain('Page role: open');
  });
});

describe('moduleAtPage', () => {
  it('maps a page to the module its minute mark falls in', () => {
    const plan = planLongFormCourse({ minutes: 60, language: 'zh' });
    expect(moduleAtPage(plan, 1, 27).index).toBe(1);
    expect(moduleAtPage(plan, 14, 27).index).toBe(4);
    expect(moduleAtPage(plan, 27, 27).index).toBe(7);
  });

  it('uses the plan own assignment when the outline kept its page count', () => {
    // Page 8 is the planned opening of module 3. Its proportional midpoint lands
    // at minute 15.5 — inside module 2, which ends at 16 — so the clock estimate
    // told the page that opens module 3 it belonged to the module before it.
    const plan = planLongFormCourse({ minutes: 60, language: 'zh' });
    expect(moduleAtPage(plan, 8, plan.scenes.length).index).toBe(3);
    expect(moduleAtPage(plan, 4, plan.scenes.length).index).toBe(2);
  });
});

describe('planForRequirement', () => {
  it('returns null for a short lesson', () => {
    expect(planForRequirement('20 分钟的入门课')).toBeNull();
    expect(planForRequirement('teach me photosynthesis')).toBeNull();
  });

  it('plans an hour and picks the speech rate from the requirement script', () => {
    const zh = planForRequirement('做一个 60 分钟的中医基础理论课')!;
    expect(zh.minutes).toBe(60);
    expect(zh.language).toBe('zh');
    expect(zh.speechRate).toBe(240);

    const en = planForRequirement('a 60 minute lecture on entropy')!;
    expect(en.language).toBe('en');
    expect(en.speechRate).toBe(145);
  });
});

describe('inferPlanLanguage', () => {
  it('reads the script the requirement is written in', () => {
    expect(inferPlanLanguage('讲解光合作用')).toBe('zh');
    expect(inferPlanLanguage('explain photosynthesis')).toBe('en');
    expect(inferPlanLanguage('用中文讲 Docker 网络')).toBe('zh');
  });
});
