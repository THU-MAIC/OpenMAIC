import { describe, it, expect } from 'vitest';
import { generateSceneContent } from '../../packages/@openmaic/generation/src/scene-generator';
import type { SceneOutline } from '../../packages/@openmaic/generation/src/index';
const outline = (widgetType: SceneOutline['widgetType']): SceneOutline => ({
  id: 'observation-test',
  type: 'interactive',
  title: 'State contract',
  description: 'Declared state',
  keyPoints: [],
  order: 0,
  widgetType,
  widgetOutline: { concept: 'State' },
});
const response =
  '<!doctype html><html><head></head><body><main id="experiment">Mock only; no state interface</main></body></html>';
describe('actual interactive generation path — no model calls', () => {
  for (const kind of [
    'simulation',
    'diagram',
    'code',
    'game',
    'visualization3d',
    'procedural-skill',
    undefined,
  ] as const) {
    it(`delivers the same observation contract for ${kind ?? 'fallback'}`, async () => {
      let calls = 0;
      const content = await generateSceneContent(
        outline(kind),
        async (system) => {
          calls++;
          expect(system).toContain(
            'declared current state for newly generated interactive content (v1)',
          );
          // One required field, and the rest deliberately unconstrained.
          expect(system).toContain('Always include it');
          expect(system).toContain('Shape it however fits the activity');
          expect(system).toContain('extra fields are allowed and are passed through unchanged');
          expect(system).toContain('without checking field names or types');
          expect(system).toContain('32768 bytes');
          // The parts the reviewer asked to keep.
          expect(system).toContain('function publishState(observation)');
          expect(system).toContain('after every semantic change');
          expect(system).toContain('Do not add a state-request message listener');
          // No structural protocol is imposed on the generator any more.
          expect(system).not.toContain('basedOnRevision');
          expect(system).not.toContain('relations');
          expect(system).not.toContain('exhaustive');
          expect(system).not.toContain('{{snippet:');
          return response;
        },
        { allowProceduralSkill: true },
      );
      expect(calls).toBe(1);
      expect(content && 'html' in content && content.html).toContain('Mock only');
      // Existing post-processing must not manufacture evidence from defaults.
      expect(content && 'html' in content && content.html).not.toContain('data-maic-observation');
    });
  }
});
