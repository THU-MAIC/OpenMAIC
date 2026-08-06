/**
 * Golden planner-prompt parity for the #1062 core extraction.
 *
 * The fixture files were produced with Vitest's `-u` snapshot mode from the
 * ORIGINAL `buildPlannerSystemPrompt` implementation in `planner.ts` at base
 * commit 9d268943, before that implementation moved to `planner-core.ts`.
 * The single-call variants extend that same provenance from the current,
 * byte-identical implementation after the extraction.
 * These assertions intentionally compare the complete strings byte-for-byte.
 */
import { describe, expect, it } from 'vitest';

import { buildPlannerSystemPrompt } from '@/lib/pbl/v2/agents/planner-core';
import type { PBLPlannerV2Input } from '@/lib/pbl/v2/types';
import type { SceneOutline } from '@/lib/types/generation';

function ordinaryInput(): PBLPlannerV2Input {
  const outline: SceneOutline = {
    id: 'outline-pbl-golden-ordinary',
    type: 'pbl',
    title: 'Neighborhood Air Quality Dashboard',
    description: 'Build a dashboard that explains local air-quality patterns.',
    keyPoints: ['data cleaning', 'visualization', 'public communication'],
    teachingObjective: 'Turn environmental observations into a clear public explanation.',
    order: 2,
    pblConfig: {
      projectTopic: 'Neighborhood Air Quality Dashboard',
      projectDescription: 'Analyze sensor readings and communicate the most important pattern.',
      targetSkills: ['data cleaning', 'chart design', 'evidence-based explanation'],
      issueCount: 4,
    },
  };

  return {
    outline,
    courseContext: {
      allOutlines: [
        {
          id: 'outline-slide-golden',
          type: 'slide',
          title: 'Reading Environmental Data',
          description: 'Distinguish measurements, trends, and anomalies.',
          keyPoints: ['measurements', 'trends'],
          teachingObjective: 'Read a small environmental dataset.',
          order: 1,
        },
        outline,
      ],
      languageDirective: 'Reply in English and keep technical terms precise.',
    },
    targetLanguage: 'en-US',
  };
}

function scenarioInput(): PBLPlannerV2Input {
  const outline: SceneOutline = {
    id: 'outline-pbl-golden-scenario',
    type: 'pbl',
    title: 'Museum Donor Negotiation',
    description: 'Practice a high-stakes conversation with a prospective donor.',
    keyPoints: ['active listening', 'framing', 'negotiation'],
    teachingObjective: 'Use careful questions and framing to reach a principled agreement.',
    order: 3,
    pblConfig: {
      projectTopic: 'Museum Donor Negotiation',
      projectDescription: 'Negotiate exhibit support without compromising curatorial independence.',
      targetSkills: ['active listening', 'reframing', 'principled negotiation'],
      issueCount: 3,
      scenarioRoleplay: true,
      scenarioBrief:
        "A long-time donor wants naming control over a new exhibit; preserve the relationship and the museum's independence.",
    },
  };

  return {
    outline,
    courseContext: {
      allOutlines: [outline],
      languageDirective: 'Use Simplified Chinese, preserving standard English negotiation terms.',
    },
    targetLanguage: 'zh-CN',
  };
}

describe('PBL v2 planner core — pre-refactor prompt goldens', () => {
  it('keeps the ordinary planner system prompt byte-identical', async () => {
    const prompt = await buildPlannerSystemPrompt(
      ordinaryInput(),
      'intermediate',
      'Reply in English and keep technical terms precise.',
      false,
    );

    await expect(prompt).toMatchFileSnapshot('./fixtures/planner-system-ordinary.txt');
  });

  it('keeps the scenario planner system prompt byte-identical', async () => {
    const prompt = await buildPlannerSystemPrompt(
      scenarioInput(),
      'advanced',
      'Use Simplified Chinese, preserving standard English negotiation terms.',
      true,
    );

    await expect(prompt).toMatchFileSnapshot('./fixtures/planner-system-scenario.txt');
  });

  it('pins the ordinary single-call planner system prompt', async () => {
    const prompt = await buildPlannerSystemPrompt(
      ordinaryInput(),
      'intermediate',
      'Reply in English and keep technical terms precise.',
      false,
      'planner-single-call-system',
    );

    await expect(prompt).toMatchFileSnapshot('./fixtures/planner-single-call-system-ordinary.txt');
  });

  it('pins the scenario single-call planner system prompt', async () => {
    const prompt = await buildPlannerSystemPrompt(
      scenarioInput(),
      'advanced',
      'Use Simplified Chinese, preserving standard English negotiation terms.',
      true,
      'planner-scenario-single-call-system',
    );

    await expect(prompt).toMatchFileSnapshot('./fixtures/planner-single-call-system-scenario.txt');
  });
});
