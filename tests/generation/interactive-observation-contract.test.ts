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
          expect(system).toContain('basedOnRevision');
          expect(system).toContain('ALWAYS an array of nonempty STRINGS');
          expect(system).toContain('function completeRender(started, graphActuallyDrawn)');
          expect(system).toContain('Publish error invalidates the old node');
          expect(system).toContain('complete` promises an exhaustive relationship set');
          expect(system).toContain(
            'a complete empty set establishes that there are no relationships there',
          );
          expect(system).toContain('history must not fill it');
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
