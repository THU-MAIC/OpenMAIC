/**
 * Which stages under the default model (`llm`) are set separately, and when
 * every stage a course is generated with is: what the home toolbar picker
 * reports next to the default model.
 */
import { describe, expect, it } from 'vitest';

import type { SlotView } from '@/lib/model-settings/client';
import {
  COURSE_GENERATION_STAGES,
  courseStagesAllOverridden,
  courseStagesPlanName,
  defaultModelOverrides,
  followsDefault,
} from '@/lib/model-settings/overrides';

import { chatPreset, makeView, withLlm, withSlots, workspaceProvider } from './fixtures';

type Effective = SlotView['effective'];

function assigned(
  resolvedAt: string,
  ref: string,
  source: 'workspace' | 'default' | 'locked' = 'workspace',
): Effective {
  const [providerId, modelId] = ref.split(':');
  return {
    status: 'assigned',
    resolvedAt: resolvedAt as SlotView['slot'],
    source,
    requirements: [],
    providerId,
    providerSource: source === 'workspace' ? 'workspace' : 'deployment',
    presetId: providerId,
    registryId: 'x',
    modelId,
  };
}

/** A slot set to a model of its own by the workspace. */
function own(slot: string, ref: string): Partial<SlotView> {
  return { assignment: ref, effective: assigned(slot, ref) };
}

/** A slot following `from` (an ancestor), resolving to its model. */
function inherits(from: string, ref: string): Partial<SlotView> {
  return { effective: assigned(from, ref) };
}

const base = () => withLlm(makeView(), 'acme:acme-large');

describe('defaultModelOverrides', () => {
  it('lists nothing while every stage inherits the default', () => {
    const view = withSlots(base(), {
      'course.outline': inherits('llm', 'acme:acme-large'),
      classroom: inherits('llm', 'acme:acme-large'),
    });
    expect(defaultModelOverrides(view)).toEqual([]);
  });

  it('leaves out a stage set to the same model as the default', () => {
    const view = withSlots(base(), { 'course.outline': own('course.outline', 'acme:acme-large') });
    expect(defaultModelOverrides(view)).toEqual([]);
  });

  it('counts a stage set to a different model', () => {
    const view = withSlots(base(), {
      'course.outline': own('course.outline', 'acme:acme-small'),
      classroom: own('classroom', 'other:gpt-5'),
    });
    expect(defaultModelOverrides(view)).toEqual([
      {
        slot: 'course.outline',
        parent: 'llm',
        target: { kind: 'model', providerId: 'acme', modelId: 'acme-small' },
      },
      {
        slot: 'classroom',
        parent: 'llm',
        target: { kind: 'model', providerId: 'other', modelId: 'gpt-5' },
      },
    ]);
  });

  it('counts the same model on another provider as different', () => {
    const view = withSlots(base(), { 'course.outline': own('course.outline', 'other:acme-large') });
    expect(defaultModelOverrides(view).map((entry) => entry.slot)).toEqual(['course.outline']);
  });

  it('counts a stage the deployment sets, though the workspace cannot change it', () => {
    const view = withSlots(base(), {
      'course.actions': {
        locked: true,
        effective: assigned('course.actions', 'server:big', 'locked'),
      },
    });
    expect(defaultModelOverrides(view).map((entry) => entry.slot)).toEqual(['course.actions']);
  });

  it('does not count a deployment-locked stage that resolves to the default model', () => {
    const view = withSlots(base(), {
      'course.actions': {
        locked: true,
        effective: assigned('course.actions', 'acme:acme-large', 'locked'),
      },
    });
    expect(defaultModelOverrides(view)).toEqual([]);
  });

  it('counts a stage turned off as set separately', () => {
    const view = withSlots(base(), {
      'course.research': {
        assignment: null,
        effective: { status: 'disabled', resolvedAt: 'course.research', source: 'workspace' },
      },
    });
    expect(defaultModelOverrides(view)).toEqual([
      { slot: 'course.research', parent: 'llm', target: { kind: 'off' } },
    ]);
  });

  it('counts a page type where it is set, not page types that inherit the content model', () => {
    const view = withSlots(base(), {
      'course.content': own('course.content', 'acme:acme-small'),
      'course.content.slide': inherits('course.content', 'acme:acme-small'),
      'course.content.quiz': inherits('course.content', 'acme:acme-small'),
      'course.content.interactive': own('course.content.interactive', 'other:gpt-5'),
      'course.content.pbl': own('course.content.pbl', 'acme:acme-large'),
    });
    expect(defaultModelOverrides(view).map((entry) => [entry.slot, entry.parent])).toEqual([
      ['course.content', 'llm'],
      ['course.content.interactive', 'course.content'],
    ]);
  });

  it('ignores slots shown only in configuration files and other capabilities', () => {
    const view = withSlots(base(), {
      'agent.title': own('agent.title', 'acme:acme-small'),
      tts: own('tts', 'acme:acme-voice'),
    });
    expect(defaultModelOverrides(view)).toEqual([]);
  });

  it('counts stages with their own model while no default is set', () => {
    const view = withSlots(makeView(), {
      'course.outline': own('course.outline', 'acme:acme-small'),
    });
    expect(defaultModelOverrides(view).map((entry) => entry.slot)).toEqual(['course.outline']);
  });

  it('lists nothing without a view', () => {
    expect(defaultModelOverrides(null)).toEqual([]);
  });
});

describe('followsDefault', () => {
  it('follows through ancestors without a setting of their own', () => {
    const view = withSlots(base(), {
      'course.content.slide': inherits('llm', 'acme:acme-large'),
    });
    expect(followsDefault(view, 'course.content.slide')).toBe(true);
  });

  it('stops at an ancestor with its own setting', () => {
    const view = withSlots(base(), {
      'course.content': own('course.content', 'acme:acme-large'),
      'course.content.slide': inherits('course.content', 'acme:acme-large'),
    });
    expect(followsDefault(view, 'course.content.slide')).toBe(false);
  });
});

/** Every course generation stage set to `ref`. */
function allCourseStages(ref: string): Record<string, Partial<SlotView>> {
  return Object.fromEntries(COURSE_GENERATION_STAGES.map((slot) => [slot, own(slot, ref)]));
}

describe('courseStagesAllOverridden', () => {
  it('is set when every course generation stage has its own model', () => {
    const view = withSlots(base(), allCourseStages('other:gpt-5'));
    expect(courseStagesAllOverridden(view)).toBe(true);
  });

  it('counts the page types through a content model set for all of them', () => {
    const view = withSlots(base(), {
      'course.outline': own('course.outline', 'other:gpt-5'),
      'course.actions': own('course.actions', 'other:gpt-5'),
      'course.content': own('course.content', 'other:gpt-5'),
      'course.content.slide': inherits('course.content', 'other:gpt-5'),
      'course.content.quiz': inherits('course.content', 'other:gpt-5'),
      'course.content.interactive': inherits('course.content', 'other:gpt-5'),
      'course.content.pbl': inherits('course.content', 'other:gpt-5'),
    });
    expect(courseStagesAllOverridden(view)).toBe(true);
  });

  it('is not set while one course stage follows the default', () => {
    const stages = allCourseStages('other:gpt-5');
    delete stages['course.content.pbl'];
    const view = withSlots(base(), stages);
    expect(courseStagesAllOverridden(view)).toBe(false);
  });

  it('does not need the optional stages (research, agents) or the classroom', () => {
    const view = withSlots(base(), {
      ...allCourseStages('other:gpt-5'),
      'course.research': inherits('llm', 'acme:acme-large'),
      'course.agents': inherits('llm', 'acme:acme-large'),
      classroom: inherits('llm', 'acme:acme-large'),
    });
    expect(courseStagesAllOverridden(view)).toBe(true);
  });

  it('counts stages the deployment locks', () => {
    const stages = allCourseStages('other:gpt-5');
    stages['course.outline'] = {
      locked: true,
      effective: assigned('course.outline', 'server:big', 'locked'),
    };
    expect(courseStagesAllOverridden(withSlots(base(), stages))).toBe(true);
  });

  it('is not set when every stage is set to the default model itself', () => {
    const view = withSlots(base(), allCourseStages('acme:acme-large'));
    expect(courseStagesAllOverridden(view)).toBe(false);
  });

  it('is not set without a view', () => {
    expect(courseStagesAllOverridden(null)).toBe(false);
  });
});

describe('courseStagesPlanName', () => {
  it('names the Token Plan every course stage resolves to', () => {
    const view = withSlots(
      { ...base(), providers: [workspaceProvider('acme')] },
      allCourseStages('acme:acme-small'),
    );
    expect(courseStagesPlanName(view)).toBe(chatPreset.name);
  });

  it('names none when the stages use more than one provider', () => {
    const stages = allCourseStages('acme:acme-small');
    stages['course.actions'] = own('course.actions', 'other:gpt-5');
    const view = withSlots(
      { ...base(), providers: [workspaceProvider('acme'), workspaceProvider('other')] },
      stages,
    );
    expect(courseStagesPlanName(view)).toBeUndefined();
  });

  it('names none for a provider that is not a Token Plan', () => {
    const view = withSlots(
      {
        ...base(),
        providers: [{ ...workspaceProvider('other'), preset: 'openai-compatible' }],
      },
      allCourseStages('other:gpt-5'),
    );
    expect(courseStagesPlanName(view)).toBeUndefined();
  });
});
