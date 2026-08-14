import { expect, it } from 'vitest';
import type {
  BuildCompleteSceneOptions,
  GeneratedPBLContent,
  PBLPlannerV2Input,
  SceneActionsOptions,
  SceneContentOptions,
} from '@openmaic/generation';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type _SceneContentKeys = Assert<
  Equal<
    keyof SceneContentOptions,
    | 'assignedImages'
    | 'imageMapping'
    | 'visionEnabled'
    | 'generatedMediaMapping'
    | 'agents'
    | 'languageDirective'
    | 'targetLanguage'
    | 'userRequirements'
    | 'allowProceduralSkill'
    | 'editDirective'
    | 'baselineContent'
    | 'pblLoopFallback'
    | 'logger'
  >
>;
type _SceneActionKeys = Assert<
  Equal<
    keyof SceneActionsOptions,
    'ctx' | 'agents' | 'userProfile' | 'languageDirective' | 'logger'
  >
>;
type _BuildKeys = Assert<Equal<keyof BuildCompleteSceneOptions, 'sceneId'>>;
type _PBLInputKeys = Assert<
  Equal<
    keyof PBLPlannerV2Input,
    'outline' | 'courseContext' | 'user' | 'priorQuizResults' | 'targetLanguage'
  >
>;

it('keeps new public option and generated-content surfaces narrow', () => {
  const contentOptions: SceneContentOptions = {};
  const actionOptions: SceneActionsOptions = {};
  const buildOptions: BuildCompleteSceneOptions = { sceneId: 'stable' };

  // Provider/model routing belongs inside the AICallFn closure.
  // @ts-expect-error languageModel is not a package scene-content option.
  const providerLeak: SceneContentOptions = { languageModel: {} };
  // @ts-expect-error projectV2 must satisfy the DSL-owned PBLProject contract.
  const invalidPBL: GeneratedPBLContent = { projectV2: { title: 'incomplete' } };

  expect(contentOptions).toEqual({});
  expect(actionOptions).toEqual({});
  expect(buildOptions.sceneId).toBe('stable');
  expect(providerLeak).toBeTruthy();
  expect(invalidPBL).toBeTruthy();
});

void (null as unknown as _SceneContentKeys);
void (null as unknown as _SceneActionKeys);
void (null as unknown as _BuildKeys);
void (null as unknown as _PBLInputKeys);
