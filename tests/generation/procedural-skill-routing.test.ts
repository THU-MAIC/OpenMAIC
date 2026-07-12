import { describe, expect, test } from 'vitest';

import { generateSceneContent, generateWidgetContent } from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { GeneratedInteractiveContent, SceneOutline } from '@/lib/types/generation';

const DIRECTIVE = '<<PROCEDURAL-SKILL-LANGUAGE-DIRECTIVE>>';

describe('procedural-skill widget content routing', () => {
  test('does not generate procedural-skill content by default', async () => {
    const aiCall: AICallFn = async () => {
      throw new Error('procedural-skill prompt should not be called');
    };

    const outline = createProceduralSkillOutline();

    await expect(generateWidgetContent(outline, aiCall)).resolves.toBeNull();
    await expect(generateSceneContent(outline, aiCall)).resolves.toBeNull();
  });

  test('routes an explicitly allowed procedural-skill widget to procedural-skill-content prompt', async () => {
    const captured: Array<{ system: string; user: string }> = [];
    const aiCall: AICallFn = async (system, user) => {
      captured.push({ system, user });
      return `<!DOCTYPE html>
<html>
  <body>
    <script type="application/json" id="widget-config">
      {
        "type": "procedural-skill",
        "task": "Calibrate a training device",
        "description": "Practice a generic calibration procedure.",
        "tools": ["multimeter"],
        "steps": [
          {
            "id": "step-1",
            "title": "Inspect the device",
            "description": "Check visible condition.",
            "successCriteria": ["No visible damage"]
          }
        ],
        "successCriteria": ["Device is ready for use"]
      }
    </script>
    <main>procedural skill widget</main>
  </body>
</html>`;
    };

    const outline = createProceduralSkillOutline();

    const content = (await generateSceneContent(outline, aiCall, {
      languageDirective: DIRECTIVE,
      allowProceduralSkill: true,
    })) as GeneratedInteractiveContent | null;

    expect(content).not.toBeNull();
    expect(content?.widgetType).toBe('procedural-skill');
    expect(content?.widgetConfig?.type).toBe('procedural-skill');

    expect(captured).toHaveLength(1);
    const widgetPrompt = captured[0];
    expect(widgetPrompt.system).toContain('# Procedural Skill Widget Content Generator');
    expect(widgetPrompt.system).toContain('"type": "procedural-skill"');
    expect(widgetPrompt.user).toContain(
      'Create a procedural skill widget for: Device Calibration Practice',
    );
    expect(widgetPrompt.user).toContain('operation');
    expect(widgetPrompt.user).toContain('Calibrate a training device');
    expect(widgetPrompt.user).toContain('multimeter');
    expect(widgetPrompt.user).toContain('Inspect the device');
    expect(widgetPrompt.user).toContain('No visible damage');
    expect(widgetPrompt.user).toContain('Unsafe readings require stopping and rechecking');
    expect(widgetPrompt.user).toContain(DIRECTIVE);
    expect(widgetPrompt.user).not.toContain('{{languageDirective}}');
    expect(widgetPrompt.user).not.toContain('{{');
  });
});

function createProceduralSkillOutline(): SceneOutline {
  return {
    id: 'scene-procedural-skill',
    type: 'interactive',
    title: 'Device Calibration Practice',
    description: 'Practice a generic calibration procedure with step feedback.',
    keyPoints: ['Follow steps in order', 'Check each success criterion'],
    order: 1,
    widgetType: 'procedural-skill',
    widgetOutline: {
      concept: 'calibration procedure',
      procedureType: 'operation',
      task: 'Calibrate a training device',
      tools: ['multimeter', 'checklist'],
      steps: ['Inspect the device', 'Connect the tool', 'Confirm the reading'],
      successCriteria: ['No visible damage', 'Reading is within range'],
      errorConsequences: ['Unsafe readings require stopping and rechecking'],
    },
  };
}
