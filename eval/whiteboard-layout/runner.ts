import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import type { EvalScenario, ScenarioRunResult, CheckpointResult, EvalReport } from './types';
import type { StatelessEvent, DirectorState } from '@/lib/types/chat';
import type { Action } from '@/lib/types/action';
import { chatStream } from './chat-client';
import { EvalStateManager } from './state-manager';
import { initCapture, captureWhiteboard, closeCapture } from './capture';
import { scoreScreenshot } from './scorer';
import { generateReport } from './reporter';

// ==================== CLI Args ====================

const { values: args } = parseArgs({
  options: {
    scenario: { type: 'string' },
    model: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    'base-url': { type: 'string', default: 'http://localhost:3000' },
    'api-key': { type: 'string' },
    'scorer-model': { type: 'string', default: 'gpt-4o' },
    'scorer-api-key': { type: 'string' },
    'output-dir': { type: 'string', default: 'eval/whiteboard-layout/results' },
  },
});

const BASE_URL = args['base-url']!;
const API_KEY = args['api-key'] || process.env.OPENAI_API_KEY || '';
const MODEL = args.model || process.env.DEFAULT_MODEL || 'openai/gpt-4o-mini';
const SCORER_MODEL = args['scorer-model']!;
const SCORER_API_KEY = args['scorer-api-key'] || API_KEY;
const REPEAT = parseInt(args.repeat || '1', 10);
const OUTPUT_DIR = args['output-dir']!;
const SCENARIO_FILTER = args.scenario;
const MAX_AGENT_TURNS = 10;

// ==================== Scenario Loading ====================

function loadScenarios(): EvalScenario[] {
  const scenarioDir = join(import.meta.dirname, 'scenarios');
  const files = readdirSync(scenarioDir).filter((f) => f.endsWith('.json'));
  const scenarios: EvalScenario[] = [];

  for (const file of files) {
    const scenario: EvalScenario = JSON.parse(readFileSync(join(scenarioDir, file), 'utf-8'));
    if (SCENARIO_FILTER && scenario.id !== SCENARIO_FILTER && !file.includes(SCENARIO_FILTER)) {
      continue;
    }
    scenarios.push(scenario);
  }

  return scenarios;
}

// ==================== Single Scenario Run ====================

async function runScenario(
  scenario: EvalScenario,
  runIndex: number,
): Promise<ScenarioRunResult> {
  const model = scenario.model || MODEL;
  const checkpoints: CheckpointResult[] = [];

  console.log(`  [run ${runIndex + 1}] Starting...`);

  const stateManager = new EvalStateManager(scenario.initialStoreState);
  let messages: Array<{ role: string; content: string; parts?: unknown[]; metadata?: unknown }> = [];
  let directorState: DirectorState | undefined = undefined;

  try {
    for (let turnIdx = 0; turnIdx < scenario.turns.length; turnIdx++) {
      const turn = scenario.turns[turnIdx];
      console.log(`    Turn ${turnIdx + 1}: "${turn.userMessage.slice(0, 50)}..."`);

      // Add user message
      messages.push({
        role: 'user',
        content: turn.userMessage,
        parts: [{ type: 'text', text: turn.userMessage }],
        metadata: { createdAt: Date.now() },
      });

      // Agent loop (mirrors frontend runAgentLoop)
      let agentTurnCount = 0;
      while (agentTurnCount < MAX_AGENT_TURNS) {
        const storeState = stateManager.getStoreState();

        let doneEvent: (StatelessEvent & { type: 'done' }) | null = null;
        let currentAgentId: string | null = null;
        let currentMessageId: string | null = null;
        const textParts: string[] = [];
        const actionParts: Array<{ type: string; actionName: string; params: unknown }> = [];

        for await (const event of chatStream({
          baseUrl: BASE_URL,
          messages,
          storeState,
          config: scenario.config,
          directorState,
          apiKey: API_KEY,
          model,
        })) {
          switch (event.type) {
            case 'agent_start':
              currentAgentId = event.data.agentId;
              currentMessageId = event.data.messageId;
              break;

            case 'text_delta':
              textParts.push(event.data.content);
              break;

            case 'action': {
              const action: Action = {
                id: event.data.actionId,
                type: event.data.actionName,
                ...event.data.params,
              } as Action;
              await stateManager.executeAction(action);
              actionParts.push({
                type: `action-${event.data.actionName}`,
                actionName: event.data.actionName,
                params: event.data.params,
              });
              break;
            }

            case 'done':
              doneEvent = event as StatelessEvent & { type: 'done' };
              break;

            case 'error':
              throw new Error(`API error: ${event.data.message}`);
          }
        }

        // Build assistant message for conversation history
        if (currentMessageId && (textParts.length > 0 || actionParts.length > 0)) {
          const parts: unknown[] = [];
          if (textParts.length > 0) {
            parts.push({ type: 'text', text: textParts.join('') });
          }
          for (const ap of actionParts) {
            parts.push({ ...ap, state: 'result', output: { success: true } });
          }
          messages.push({
            role: 'assistant',
            content: textParts.join(''),
            parts,
            metadata: {
              senderName: currentAgentId || 'agent',
              originalRole: 'agent',
              agentId: currentAgentId,
              createdAt: Date.now(),
            },
          });
        }

        // Check loop exit conditions
        if (doneEvent) {
          directorState = doneEvent.data.directorState;
          if (doneEvent.data.totalAgents === 0) break;
        }

        agentTurnCount++;
      }

      // Checkpoint: capture + score
      const isLastTurn = turnIdx === scenario.turns.length - 1;
      if (turn.checkpoint || isLastTurn) {
        const elements = stateManager.getWhiteboardElements();
        const screenshotFilename = `${scenario.id}_run${runIndex}_turn${turnIdx}.png`;
        const screenshotPath = await captureWhiteboard(elements, OUTPUT_DIR, screenshotFilename);

        console.log(`    Captured: ${screenshotFilename} (${elements.length} elements)`);

        const score = await scoreScreenshot(screenshotPath, {
          apiKey: SCORER_API_KEY,
          model: SCORER_MODEL,
        });

        console.log(`    Score: overall=${score.overall}, overlap=${score.overlap.score}`);

        checkpoints.push({
          turnIndex: turnIdx,
          screenshotPath,
          score,
          elements,
        });
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`    Error: ${msg}`);
    return { scenarioId: scenario.id, runIndex, model, checkpoints, error: msg };
  } finally {
    stateManager.dispose();
  }

  return { scenarioId: scenario.id, runIndex, model, checkpoints };
}

// ==================== Main ====================

async function main() {
  console.log('=== Whiteboard Layout Eval ===');
  console.log(`Model: ${MODEL} | Scorer: ${SCORER_MODEL} | Repeats: ${REPEAT}`);
  console.log('');

  const scenarios = loadScenarios();
  if (scenarios.length === 0) {
    console.error('No scenarios found. Check eval/whiteboard-layout/scenarios/');
    process.exit(1);
  }
  console.log(`Loaded ${scenarios.length} scenario(s)`);

  await initCapture(BASE_URL);

  const allResults: ScenarioRunResult[] = [];

  for (const scenario of scenarios) {
    console.log(`\nScenario: ${scenario.name} (${scenario.id})`);
    const repeats = scenario.repeat ?? REPEAT;

    for (let r = 0; r < repeats; r++) {
      const result = await runScenario(scenario, r);
      allResults.push(result);
    }
  }

  await closeCapture();

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    scenarios: allResults,
  };

  const { json, md } = generateReport(report, OUTPUT_DIR);
  console.log(`\nReport saved:`);
  console.log(`  JSON: ${json}`);
  console.log(`  Markdown: ${md}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
