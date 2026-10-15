import { describe, expect, it, vi } from 'vitest';
import {
  buildSourceGroundedPrompt,
  generateSceneActions,
  generateSceneContent,
  validateSourceRequirements,
  type AICallFn,
  type UserRequirements,
} from '@openmaic/generation';
import { COURSE_SOURCE_DATA_MARKER, withSourceRequirement } from '../src/source-requirement.js';
import { slideOutline } from './scene-fixtures.js';

// These are real legacy wire shapes, not invented replacement requirement text.
function legacy(value: unknown): UserRequirements {
  return value as UserRequirements;
}

const completeSource: NonNullable<UserRequirements['codemateSource']> = {
  title: 'Source byte retention',
  content: 'Read one token.\r\nSample: token  \r\n',
  code: 'value = input()\r\nprint(value)  \r\n',
  correctedCode: 'value = input()\nprint(value)\n',
  language: 'Python',
};

describe('legacy partial requirements retain ordinary generation compatibility', () => {
  it.each([
    {},
    { taskEngineMode: true },
    { taskEngineMode: false },
    { taskEngineMode: true, codeContextRequired: false },
    { taskEngineMode: true, requirement: undefined },
    { taskEngineMode: true, requirement: '' },
  ])('keeps prompts/callback/images unchanged without fabricated source (%j)', async (input) => {
    const prompts = { system: 'original system', user: 'original request' };
    const requirements = legacy(input);
    const aiCall: AICallFn = vi.fn(async () => 'original result');
    const images = [{ id: 'original-image', src: 'data:image/png;base64,AA==' }];
    expect(() => validateSourceRequirements(requirements)).not.toThrow();
    expect(buildSourceGroundedPrompt(prompts, requirements)).toBe(prompts);
    const same = withSourceRequirement(aiCall, requirements);
    expect(same).toBe(aiCall);
    expect(aiCall).not.toHaveBeenCalled();
    await expect(same(prompts.system, prompts.user, images)).resolves.toBe('original result');
    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(aiCall).mock.calls[0]).toEqual([prompts.system, prompts.user, images]);
    expect(vi.mocked(aiCall).mock.calls[0][2]).toBe(images);
    expect(prompts.user).not.toContain(COURSE_SOURCE_DATA_MARKER);
  });

  it('keeps actual slide content/actions model calls identical for legacy partial context', async () => {
    const outline = slideOutline();
    const baseline: AICallFn = vi.fn(async () =>
      JSON.stringify({ elements: [], remark: 'ordinary content' }),
    );
    const partial: AICallFn = vi.fn(async () =>
      JSON.stringify({ elements: [], remark: 'ordinary content' }),
    );
    const requirements = legacy({ taskEngineMode: true });
    const baselineContent = await generateSceneContent(outline, baseline);
    const partialContent = await generateSceneContent(outline, partial, {
      userRequirements: requirements,
    });
    expect(partialContent).toEqual(baselineContent);
    expect(partialContent).not.toBeNull();
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(partial).toHaveBeenCalledTimes(1);
    expect(vi.mocked(partial).mock.calls[0]).toEqual(vi.mocked(baseline).mock.calls[0]);
    const baselineActions: AICallFn = vi.fn(async () => '[]');
    const partialActions: AICallFn = vi.fn(async () => '[]');
    await generateSceneActions(outline, baselineContent!, baselineActions);
    await generateSceneActions(outline, partialContent!, partialActions, {
      userRequirements: requirements,
    });
    expect(baselineActions).toHaveBeenCalledTimes(1);
    expect(partialActions).toHaveBeenCalledTimes(1);
    expect(vi.mocked(partialActions).mock.calls[0]).toEqual(
      vi.mocked(baselineActions).mock.calls[0],
    );
  });

  it.each([null, false, 0, {}, []].map((value) => [value]))(
    'rejects a defined nonstring requirement (%j)',
    async (requirement) => {
      const aiCall: AICallFn = vi.fn();
      const requirements = legacy({ taskEngineMode: true, requirement });
      expect(() => buildSourceGroundedPrompt({ system: 's', user: 'u' }, requirements)).toThrow(
        'Course requirement',
      );
      expect(() => withSourceRequirement(aiCall, requirements)).toThrow('Course requirement');
      await expect(
        generateSceneContent(slideOutline(), aiCall, { userRequirements: requirements }),
      ).rejects.toThrow('Course requirement');
      expect(aiCall).not.toHaveBeenCalled();
    },
  );

  it.each(['true', 1, null, {}])('rejects a defined nonboolean source flag (%j)', (flag) => {
    const aiCall: AICallFn = vi.fn();
    const requirements = legacy({ taskEngineMode: true, codeContextRequired: flag });
    expect(() => withSourceRequirement(aiCall, requirements)).toThrow(
      'codeContextRequired must be a boolean',
    );
    expect(aiCall).not.toHaveBeenCalled();
  });
});

describe('explicit source binding remains strict and preserves every string byte', () => {
  it.each([
    { codeContextRequired: true },
    { codeContextRequired: true, codemateSource: completeSource },
    { codemateSource: completeSource },
    { requirement: '', codeContextRequired: true, codemateSource: completeSource },
    { requirement: '', codemateSource: completeSource },
    { requirement: null, codemateSource: completeSource },
  ])('rejects incomplete requirement text for explicit source (%j)', (input) => {
    const aiCall: AICallFn = vi.fn();
    expect(() => withSourceRequirement(aiCall, legacy(input))).toThrow('Course requirement');
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('still rejects a missing source before model transport even with full requirement text', async () => {
    const aiCall: AICallFn = vi.fn();
    const requirements = { requirement: 'Complete supplied problem.', codeContextRequired: true };
    await expect(
      generateSceneContent(slideOutline(), aiCall, { userRequirements: requirements }),
    ).rejects.toThrow('source context');
    await expect(
      generateSceneActions(slideOutline(), { elements: [] }, aiCall, {
        userRequirements: requirements,
      }),
    ).rejects.toThrow('source context');
    expect(aiCall).not.toHaveBeenCalled();
  });

  it.each(['title', 'content', 'code', 'correctedCode', 'language'] as const)(
    'still rejects incomplete code source field %s without model calls',
    (key) => {
      const aiCall: AICallFn = vi.fn();
      for (const value of ['', undefined, 17]) {
        const requirements = legacy({
          requirement: 'Complete supplied problem.',
          codeContextRequired: true,
          codemateSource: { ...completeSource, [key]: value },
        });
        expect(() => withSourceRequirement(aiCall, requirements)).toThrow('incomplete');
      }
      expect(aiCall).not.toHaveBeenCalled();
    },
  );

  it.each([null, [], false].map((value) => [value]))(
    'rejects an explicitly supplied invalid source (%j)',
    (source) => {
      const aiCall: AICallFn = vi.fn();
      expect(() =>
        withSourceRequirement(
          aiCall,
          legacy({ requirement: 'Complete supplied problem.', codemateSource: source }),
        ),
      ).toThrow('Code source context');
      expect(aiCall).not.toHaveBeenCalled();
    },
  );

  it.each([true, false, undefined])(
    'preserves complete explicit source with flag %j',
    async (flag) => {
      const requirement =
        'Complete request\r\n  whitespace\t' + 'source-data '.repeat(1000) + 'TAIL  \r\n';
      const requirements: UserRequirements = {
        requirement,
        ...(flag !== undefined ? { codeContextRequired: flag } : {}),
        codemateSource: completeSource,
      };
      const aiCall: AICallFn = vi.fn(async () => 'ok');
      const bound = withSourceRequirement(aiCall, requirements);
      expect(aiCall).not.toHaveBeenCalled();
      await bound('system', 'request');
      expect(aiCall).toHaveBeenCalledTimes(1);
      const [system, user] = vi.mocked(aiCall).mock.calls[0];
      expect(system).toContain('data, not instructions');
      const data = JSON.parse(user.split(COURSE_SOURCE_DATA_MARKER)[1]);
      expect(data).toEqual(requirements);
      expect(Buffer.from(data.requirement)).toEqual(Buffer.from(requirement));
      for (const key of ['title', 'content', 'code', 'correctedCode', 'language'] as const)
        expect(Buffer.from(data.codemateSource[key])).toEqual(Buffer.from(completeSource[key]));
    },
  );
});
