import { readFileSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import type { EvalScenario, ScenarioRunResult, CheckpointResult, EvalReport } from './types';
import type { Action } from '@/lib/types/action';
import { runAgentLoop, type AgentLoopIterationResult } from '@/lib/chat/agent-loop';
import { EvalStateManager } from './state-manager';
import { initCapture, captureWhiteboard, closeCapture } from './capture';
import { scoreScreenshot } from './scorer';
import { generateReport } from './reporter';

// ==================== CLI Args ====================
//
// Model configuration follows the same pattern as the outline-language eval:
//   EVAL_CHAT_MODEL    Model for chat generation (default: DEFAULT_MODEL or gpt-4o-mini)
//   EVAL_SCORER_MODEL  Model for VLM scoring (default: openai:gpt-4o)
//
// Usage:
//   EVAL_CHAT_MODEL=google:gemini-3.1-pro-preview \
//   EVAL_SCORER_MODEL=google:gemini-2.0-flash \
//   pnpm eval:whiteboard --scenario physics-force-decomposition

const { values: args } = parseArgs({
  options: {
    scenario: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    'base-url': { type: 'string', default: 'http://localhost:3000' },
    'output-dir': { type: 'string', default: 'eval/whiteboard-layout/results' },
    rescore: { type: 'string' }, // Path to existing run dir — rescore only, no chat
  },
});

const BASE_URL = args['base-url']!;
const CHAT_MODEL = process.env.EVAL_CHAT_MODEL || process.env.DEFAULT_MODEL || 'openai:gpt-4o-mini';
const SCORER_MODEL = process.env.EVAL_SCORER_MODEL || 'openai:gpt-4o';
const REPEAT = parseInt(args.repeat || '1', 10);
const OUTPUT_DIR = args['output-dir']!;
const SCENARIO_FILTER = args.scenario;
const MAX_AGENT_TURNS = 10;

// ==================== Scenario Loading ====================

function loadScenarios(): EvalScenario[] {
  const currentDir =
    typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
  const scenarioDir = join(currentDir, 'scenarios');
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
  runDir: string,
): Promise<ScenarioRunResult> {
  const model = scenario.model || CHAT_MODEL;
  const checkpoints: CheckpointResult[] = [];

  console.log(`  [run ${runIndex + 1}] Starting...`);

  // Per-scenario sub-directory: runDir/<scenario-id>/
  const scenarioDir = join(runDir, scenario.id);
  mkdirSync(scenarioDir, { recursive: true });

  const stateManager = new EvalStateManager(scenario.initialStoreState);
  const messages: Array<{
    role: string;
    content: string;
    parts?: unknown[];
    metadata?: unknown;
  }> = [];

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

      // Per-iteration state for the eval callbacks
      let iterResult: AgentLoopIterationResult | null = null;
      let currentAgentId: string | null = null;
      let currentMessageId: string | null = null;
      const textParts: string[] = [];
      const actionParts: Array<{ type: string; actionName: string; params: unknown }> = [];
      let cueUserReceived = false;
      // Serial action queue: `wb_*` actions must apply in emission order because
      // ActionEngine.ensureWhiteboardOpen() awaits an internal delay on first
      // call, which would let later actions race ahead and insert elements
      // out of order. We chain each execute() onto the previous one and await
      // the tail in onIterationEnd before the screenshot.
      let actionChain: Promise<void> = Promise.resolve();

      // Use the shared agent loop — same logic as frontend
      const controller = new AbortController();
      await runAgentLoop(
        {
          config: scenario.config,
          apiKey: '', // Server resolves API key from env/YAML
          model,
        },
        {
          getStoreState: () => stateManager.getStoreState(),
          getMessages: () => messages,

          fetchChat: async (body, signal) => {
            // Reset per-iteration accumulators
            currentAgentId = null;
            currentMessageId = null;
            textParts.length = 0;
            actionParts.length = 0;
            cueUserReceived = false;
            iterResult = null;
            actionChain = Promise.resolve();

            return fetch(`${BASE_URL}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal,
            });
          },

          onEvent: (event) => {
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
                // Serialize execution: chain each action onto the previous
                // one so they apply in emission order. We await `actionChain`
                // in onIterationEnd before screenshotting.
                actionChain = actionChain.then(() => stateManager.executeAction(action));
                actionParts.push({
                  type: `action-${event.data.actionName}`,
                  actionName: event.data.actionName,
                  params: event.data.params,
                });
                break;
              }

              case 'cue_user':
                cueUserReceived = true;
                break;

              case 'done':
                iterResult = {
                  directorState: event.data.directorState,
                  totalAgents: event.data.totalAgents,
                  agentHadContent: event.data.agentHadContent ?? true,
                  cueUserReceived,
                };
                break;

              case 'error':
                throw new Error(`API error: ${event.data.message}`);
            }
          },

          onIterationEnd: async () => {
            // Wait for all queued actions to apply to the store before we
            // use its state (message construction, screenshot capture).
            try {
              await actionChain;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`    Action execution error: ${msg.slice(0, 120)}`);
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

            return iterResult;
          },
        },
        controller.signal,
        MAX_AGENT_TURNS,
      );

      // Checkpoint: capture + score
      const isLastTurn = turnIdx === scenario.turns.length - 1;
      if (turn.checkpoint || isLastTurn) {
        const elements = stateManager.getWhiteboardElements();
        const screenshotFilename = `run${runIndex}_turn${turnIdx}.png`;
        const screenshotPath = await captureWhiteboard(elements, scenarioDir, screenshotFilename);

        console.log(`    Captured: ${screenshotFilename} (${elements.length} elements)`);

        try {
          const score = await scoreScreenshot(screenshotPath, SCORER_MODEL);
          console.log(`    Score: overall=${score.overall}, overlap=${score.overlap.score}`);
          checkpoints.push({ turnIndex: turnIdx, screenshotPath, score, elements });
        } catch (scoreErr) {
          const msg = scoreErr instanceof Error ? scoreErr.message : String(scoreErr);
          console.error(`    Score error (continuing): ${msg.slice(0, 120)}`);
          // Preserve screenshot with null score so the report can still include it
          checkpoints.push({ turnIndex: turnIdx, screenshotPath, score: null, elements });
        }
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

// ==================== Rescore Mode ====================

async function rescoreRun(runDir: string) {
  console.log('=== Rescore Mode ===');
  console.log(`Scorer: ${SCORER_MODEL}`);
  console.log(`Run dir: ${runDir}`);

  // Read the existing report to get scenario metadata
  const reportPath = join(runDir, 'report.json');
  const oldReport: EvalReport = JSON.parse(readFileSync(reportPath, 'utf-8'));

  const allResults: ScenarioRunResult[] = [];

  for (const oldResult of oldReport.scenarios) {
    console.log(`\nScenario: ${oldResult.scenarioId} (run ${oldResult.runIndex + 1})`);
    const checkpoints: CheckpointResult[] = [];

    for (const oldCp of oldResult.checkpoints) {
      const pngPath = oldCp.screenshotPath;
      console.log(`  Rescoring: ${pngPath}`);

      try {
        const score = await scoreScreenshot(pngPath, SCORER_MODEL);
        console.log(`    Score: overall=${score.overall}, overlap=${score.overlap.score}`);
        checkpoints.push({ ...oldCp, score });
      } catch (scoreErr) {
        const msg = scoreErr instanceof Error ? scoreErr.message : String(scoreErr);
        console.error(`    Score error: ${msg.slice(0, 120)}`);
        checkpoints.push(oldCp); // Keep old score
      }
    }

    allResults.push({ ...oldResult, checkpoints });
  }

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    model: oldReport.model,
    scenarios: allResults,
  };

  const { json, md } = generateReport(report, runDir);
  console.log(`\nReport saved:`);
  console.log(`  JSON: ${json}`);
  console.log(`  Markdown: ${md}`);
}

// ==================== Main ====================

async function main() {
  // Rescore mode: only re-score existing screenshots
  if (args.rescore) {
    await rescoreRun(args.rescore);
    return;
  }

  console.log('=== Whiteboard Layout Eval ===');
  console.log(`Chat: ${CHAT_MODEL} | Scorer: ${SCORER_MODEL} | Repeats: ${REPEAT}`);
  console.log('');

  const scenarios = loadScenarios();
  if (scenarios.length === 0) {
    console.error('No scenarios found. Check eval/whiteboard-layout/scenarios/');
    process.exit(1);
  }
  console.log(`Loaded ${scenarios.length} scenario(s)`);

  // Create run directory: results/<model>/<timestamp>/
  const sanitizedModel = CHAT_MODEL.replace(/[:/]/g, '-');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = join(OUTPUT_DIR, sanitizedModel, timestamp);
  mkdirSync(runDir, { recursive: true });
  console.log(`Output: ${runDir}`);

  await initCapture(BASE_URL);

  const allResults: ScenarioRunResult[] = [];

  for (const scenario of scenarios) {
    console.log(`\nScenario: ${scenario.name} (${scenario.id})`);
    const repeats = scenario.repeat ?? REPEAT;

    for (let r = 0; r < repeats; r++) {
      const result = await runScenario(scenario, r, runDir);
      allResults.push(result);
    }
  }

  await closeCapture();

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    model: CHAT_MODEL,
    scenarios: allResults,
  };

  const { json, md } = generateReport(report, runDir);
  console.log(`\nReport saved:`);
  console.log(`  JSON: ${json}`);
  console.log(`  Markdown: ${md}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
