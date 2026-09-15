import { describe, expect, it } from 'vitest';

import { buildGoldenDemoClassroom } from '@/lib/demo/golden-classroom';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';

describe('golden demo classroom', () => {
  it('builds a valid deterministic four-step learning experience', () => {
    const first = buildGoldenDemoClassroom('demo-stage', 100);
    const second = buildGoldenDemoClassroom('demo-stage', 100);

    expect(second).toEqual(first);
    expect(first.stage).toMatchObject({
      id: 'demo-stage',
      interactiveMode: true,
      style: 'zhigou-learning-lab',
    });
    expect(first.scenes.map((scene) => scene.type)).toEqual([
      'slide',
      'interactive',
      'quiz',
      'slide',
    ]);
    expect(validateAppStage(first.stage)).toEqual({ valid: true });
    for (const scene of first.scenes) {
      expect(validateAppScene(scene), scene.title).toEqual({ valid: true });
    }
  });

  it('keeps the interactive experiment self-contained and branded', () => {
    const demo = buildGoldenDemoClassroom('demo-stage', 100);
    const experiment = demo.scenes.find((scene) => scene.type === 'interactive');
    const quiz = demo.scenes.find((scene) => scene.type === 'quiz');

    expect(experiment?.content.type).toBe('interactive');
    if (experiment?.content.type === 'interactive') {
      expect(experiment.content.url).toBe('');
      expect(experiment.content.html).toContain('参数实验室');
      expect(experiment.content.html).toContain('#0f766e');
      expect(experiment.content.html).not.toMatch(/https?:\/\//);
    }
    expect(quiz?.content.type).toBe('quiz');
    if (quiz?.content.type === 'quiz') expect(quiz.content.questions).toHaveLength(3);
  });
});
