import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StatelessChatRequest } from '@/lib/types/chat';
import { resolveEvalModel } from '../shared/resolve-model';
import { createRunDir } from '../shared/run-dir';
import { scenarioAgentConfig } from './pi-harness';
import { runChildFailureEval, type ChildFailureScenario } from './child-failure';

async function main() {
  const model = await resolveEvalModel('EVAL_DIRECTOR_MODEL', process.env.DEFAULT_MODEL);
  const samples = Number(process.env.EVAL_SAMPLES ?? 1);
  if (!Number.isInteger(samples) || samples <= 0)
    throw new Error('EVAL_SAMPLES must be a positive integer');
  const baseRequest = {
    messages: [
      {
        id: 'question',
        role: 'user',
        parts: [{ type: 'text', text: 'Explain why the seasons change.' }],
      },
    ],
    storeState: {
      stage: { id: 'failure-eval', name: 'Child failure eval', createdAt: 1, updatedAt: 1 },
      outlines: [],
      scenes: [],
      currentSceneId: null,
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    apiKey: '',
  };
  const teacher = scenarioAgentConfig({
    id: 'teacher',
    name: 'Teacher',
    role: 'teacher',
    priority: 10,
  });
  const assistant = scenarioAgentConfig({
    id: 'assistant',
    name: 'Teaching assistant',
    role: 'assistant',
    priority: 5,
  });
  // A student alone does not satisfy the normal teaching check, so this roster
  // exercises the cue_user exception after a teacher failure.
  const student = scenarioAgentConfig({
    id: 'student',
    name: 'Student',
    role: 'student',
    priority: 3,
  });
  const requestFor = (scenario: ChildFailureScenario): StatelessChatRequest => {
    const agents = scenario === 'teacher-error-student' ? [teacher, student] : [teacher, assistant];
    return {
      ...baseRequest,
      config: { agentIds: agents.map((agent) => agent.id), agentConfigs: agents },
    } as StatelessChatRequest;
  };
  const scenarios: ChildFailureScenario[] = [
    'error',
    'timeout',
    'empty',
    'teacher-error',
    'teacher-error-student',
    'partial',
  ];
  const selected = scenarios.filter(
    (scenario) => !process.env.EVAL_SCENARIO || process.env.EVAL_SCENARIO === scenario,
  );
  if (!selected.length) throw new Error('Unknown EVAL_SCENARIO');
  const modelName = process.env.EVAL_DIRECTOR_MODEL ?? process.env.DEFAULT_MODEL!;
  const directory = createRunDir('eval/orchestration/results-child-failure', modelName);
  for (const mode of ['legacy', 'native'] as const) {
    for (const scenario of selected) {
      for (let sample = 1; sample <= samples; sample++) {
        const report = await runChildFailureEval(requestFor(scenario), model, scenario, mode);
        writeFileSync(
          join(directory, `${mode}-${scenario}-${sample}.json`),
          JSON.stringify({ model: modelName, ...report }, null, 2),
        );
        console.log(
          `${mode}/${scenario}/${sample}: ${report.ending}, covered=${report.covered}, child calls=${report.childCalls}, capped=${report.capped}`,
        );
      }
    }
  }
  console.log(`Reports: ${directory}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
