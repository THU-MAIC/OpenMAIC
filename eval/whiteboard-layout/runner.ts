import { readFileSync, readdirSync, mkdirSync, realpathSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import type { EvalScenario, ScenarioRunResult, CheckpointResult, EvalReport } from './types';
import type { Action } from '@/lib/types/action';
import type { DirectorState, StatelessEvent } from '@/lib/types/chat';
import { EvalStateManager } from './state-manager';
import { initCapture, captureWhiteboard, closeCapture } from './capture';
import { scoreScreenshot } from './scorer';
import { generateReport } from './reporter';
import { createRunDir } from '../shared/run-dir';

// ==================== CLI Args ====================
//
// Required env:
//   EVAL_CHAT_MODEL (or DEFAULT_MODEL)  Model for chat generation
//   EVAL_SCORER_MODEL                   Model for VLM scoring
//
// Usage:
//   EVAL_CHAT_MODEL=<provider:model> \
//   EVAL_SCORER_MODEL=<provider:model> \
//   pnpm eval:whiteboard --scenario physics-force-decomposition

export interface RunConfig {
  baseUrl: string;
  chatModel: string;
  scorerModel: string;
  enableThinking: boolean;
}

function readCli() {
  const { values: args } = parseArgs({
    options: {
      scenario: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      'base-url': { type: 'string', default: 'http://localhost:3000' },
      'output-dir': { type: 'string', default: 'eval/whiteboard-layout/results' },
      rescore: { type: 'string' }, // Path to existing run dir — rescore only, no chat
    },
  });

  const chatModel = process.env.EVAL_CHAT_MODEL || process.env.DEFAULT_MODEL;
  const scorerModel = process.env.EVAL_SCORER_MODEL;
  if (!chatModel) {
    console.error(
      'Error: EVAL_CHAT_MODEL (or DEFAULT_MODEL) must be set. Example: EVAL_CHAT_MODEL=openai:gpt-4.1',
    );
    process.exit(1);
  }
  if (!scorerModel) {
    console.error(
      'Error: EVAL_SCORER_MODEL must be set. Example: EVAL_SCORER_MODEL=google:gemini-2.5-flash',
    );
    process.exit(1);
  }
  const config: RunConfig = {
    baseUrl: args['base-url']!,
    chatModel,
    scorerModel,
    enableThinking:
      process.env.EVAL_ENABLE_THINKING === '1' || process.env.EVAL_ENABLE_THINKING === 'true',
  };
  return {
    config,
    repeat: parseInt(args.repeat || '1', 10),
    outputDir: args['output-dir']!,
    scenarioFilter: args.scenario,
    rescore: args.rescore,
  };
}

// ==================== Scenario Loading ====================

function loadScenarios(scenarioFilter: string | undefined): EvalScenario[] {
  const currentDir =
    typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
  const scenarioDir = join(currentDir, 'scenarios');
  const files = readdirSync(scenarioDir).filter((f) => f.endsWith('.json'));
  const scenarios: EvalScenario[] = [];

  for (const file of files) {
    const scenario: EvalScenario = JSON.parse(readFileSync(join(scenarioDir, file), 'utf-8'));
    if (scenarioFilter && scenario.id !== scenarioFilter && !file.includes(scenarioFilter)) {
      continue;
    }
    scenarios.push(scenario);
  }

  return scenarios;
}

// ==================== Pi SSE Stream ====================

type DoneData = Extract<StatelessEvent, { type: 'done' }>['data'];

interface AgentMessageDraft {
  agentId: string;
  textParts: string[];
  actionParts: Array<{ type: string; actionName: string; params: unknown }>;
  sealed: boolean;
}

async function* readSseEvents(response: Response): AsyncGenerator<StatelessEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line.startsWith('data: ')) continue;
        let event: StatelessEvent;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue; // Skip malformed events (heartbeats, etc.)
        }
        yield event;
      }
    }
  } finally {
    // A consumer that stops early (an error or native event) would otherwise
    // leave the server producing; cancel the body so the request ends too.
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// ==================== Single Scenario Run ====================

export async function runScenario(
  scenario: EvalScenario,
  runIndex: number,
  runDir: string,
  config: RunConfig,
): Promise<ScenarioRunResult> {
  const model = scenario.model || config.chatModel;
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

  // Per-turn wall-clock latency around the Pi request. Used to compare cost
  // when toggling EVAL_ENABLE_THINKING.
  const turnDurationsMs: number[] = [];

  // Carried from each turn's done event into the next request, as the app
  // does within a session; starts empty for every scenario run.
  let directorState: DirectorState | undefined;

  try {
    for (let turnIdx = 0; turnIdx < scenario.turns.length; turnIdx++) {
      const turn = scenario.turns[turnIdx];
      console.log(`    Turn ${turnIdx + 1}: "${turn.userMessage.slice(0, 50)}..."`);

      messages.push({
        role: 'user',
        content: turn.userMessage,
        parts: [{ type: 'text', text: turn.userMessage }],
        metadata: { createdAt: Date.now() },
      });

      // One Pi request per scripted user turn. Within it the director may hand
      // the turn to several agents, so text and actions are grouped by the
      // messageId of each agent_start and sealed into its own history message
      // at agent_end.
      const turnStartMs = Date.now();
      // Serial action queue: `wb_*` actions must apply in emission order because
      // ActionEngine.ensureWhiteboardOpen() awaits an internal delay on first
      // call, which would let later actions race ahead and insert elements
      // out of order. We chain each execute() onto the previous one and await
      // the tail once the request ends, before the screenshot.
      let actionChain: Promise<void> = Promise.resolve();
      const request = new AbortController();
      try {
        const response = await fetch(`${config.baseUrl}/api/chat/pi`, {
          method: 'POST',
          signal: request.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages,
            storeState: stateManager.getStoreState(),
            // The app enables whiteboard tools for in-class requests; without
            // this flag Pi offers only spotlight/laser and the board stays empty.
            config: { ...scenario.config, piEnableWhiteboardTools: true },
            directorState,
            // The server resolves the key from its configuration.
            model,
            // Inject thinking config when EVAL_ENABLE_THINKING is set. The chat
            // route defaults to disabled; this opt-in lets us measure latency /
            // quality tradeoff without changing prod.
            ...(config.enableThinking ? { thinking: { enabled: true } } : {}),
          }),
        });
        if (!response.ok) {
          throw new Error(`API error: ${response.status} - ${await response.text()}`);
        }

        const agentMessages = new Map<string, AgentMessageDraft>();
        let currentMessageId: string | null = null;
        let done: DoneData | null = null;

        const draftFor = (messageId: string | undefined): AgentMessageDraft | undefined =>
          agentMessages.get(messageId ?? currentMessageId ?? '');
        const seal = (draft: AgentMessageDraft) => {
          if (draft.sealed) return;
          draft.sealed = true;
          if (draft.textParts.length === 0 && draft.actionParts.length === 0) return;
          const text = draft.textParts.join('');
          const parts: unknown[] = text ? [{ type: 'text', text }] : [];
          for (const ap of draft.actionParts) {
            parts.push({ ...ap, state: 'result', output: { success: true } });
          }
          messages.push({
            role: 'assistant',
            content: text,
            parts,
            metadata: {
              senderName: draft.agentId,
              originalRole: 'agent',
              agentId: draft.agentId,
              createdAt: Date.now(),
            },
          });
        };

        for await (const event of readSseEvents(response)) {
          switch (event.type) {
            case 'agent_start':
              currentMessageId = event.data.messageId;
              agentMessages.set(event.data.messageId, {
                agentId: event.data.agentId,
                textParts: [],
                actionParts: [],
                sealed: false,
              });
              break;

            case 'text_delta':
              draftFor(event.data.messageId)?.textParts.push(event.data.content);
              break;

            case 'action': {
              const action: Action = {
                id: event.data.actionId,
                type: event.data.actionName,
                ...event.data.params,
              } as Action;
              actionChain = actionChain.then(() => stateManager.executeAction(action));
              // Settled below; until then a rejection must not surface as unhandled.
              actionChain.catch(() => {});
              draftFor(event.data.messageId)?.actionParts.push({
                type: `action-${event.data.actionName}`,
                actionName: event.data.actionName,
                params: event.data.params,
              });
              break;
            }

            case 'agent_end': {
              const draft = agentMessages.get(event.data.messageId);
              if (draft) seal(draft);
              break;
            }

            case 'whiteboard':
              // Only the native child runtime emits these; its board lives in the
              // server RuntimeStore, which this harness cannot observe. Not seeing
              // one does not prove the server runs the legacy child.
              throw new Error(
                'Server emitted a native whiteboard event; run the eval against a server with the legacy child runtime',
              );

            case 'done':
              done = event.data;
              break;

            case 'error':
              throw new Error(`API error: ${event.data.message}`);
          }
        }
        if (!done) {
          throw new Error('Stream ended without a done event');
        }
        for (const draft of agentMessages.values()) seal(draft);
        directorState = done.directorState ?? directorState;
        if (done.sessionClosed) {
          console.log(`      Session closed (${done.endReason ?? 'no reason'})`);
        }
      } finally {
        // On every exit, including a failed stream: stop the request if it is
        // still running, then let queued actions finish before the next turn,
        // the screenshot, or dispose() and the next scenario (the stores are
        // shared singletons).
        request.abort();
        try {
          await actionChain;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`    Action execution error: ${msg.slice(0, 120)}`);
        }
      }
      const turnDurationMs = Date.now() - turnStartMs;
      turnDurationsMs.push(turnDurationMs);
      console.log(
        `      [timing] turn ${turnIdx + 1} ran in ${(turnDurationMs / 1000).toFixed(1)}s`,
      );

      // Checkpoint: capture + score
      const isLastTurn = turnIdx === scenario.turns.length - 1;
      const isCheckpoint = turn.checkpoint || isLastTurn;

      if (isCheckpoint) {
        const elements = stateManager.getWhiteboardElements();
        const screenshotFilename = `run${runIndex}_turn${turnIdx}.png`;
        const screenshotPath = await captureWhiteboard(elements, scenarioDir, screenshotFilename);
        console.log(`    Captured: ${screenshotFilename} (${elements.length} elements)`);

        try {
          const score = await scoreScreenshot(screenshotPath, config.scorerModel);
          console.log(`    Score: overall=${score.overall}, overlap=${score.overlap.score}`);
          checkpoints.push({ turnIndex: turnIdx, screenshotPath, score, elements });
        } catch (scoreErr) {
          const msg = scoreErr instanceof Error ? scoreErr.message : String(scoreErr);
          console.error(`    Score error (continuing): ${msg.slice(0, 120)}`);
          checkpoints.push({ turnIndex: turnIdx, screenshotPath, score: null, elements });
        }
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`    Error: ${msg}`);
    return { scenarioId: scenario.id, runIndex, model, checkpoints, turnDurationsMs, error: msg };
  } finally {
    stateManager.dispose();
  }

  return { scenarioId: scenario.id, runIndex, model, checkpoints, turnDurationsMs };
}

// ==================== Rescore Mode ====================

async function rescoreRun(runDir: string, scorerModel: string) {
  console.log('=== Rescore Mode ===');
  console.log(`Scorer: ${scorerModel}`);
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
        const score = await scoreScreenshot(pngPath, scorerModel);
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
  const { config, repeat, outputDir, scenarioFilter, rescore } = readCli();

  // Rescore mode: only re-score existing screenshots
  if (rescore) {
    await rescoreRun(rescore, config.scorerModel);
    return;
  }

  console.log('=== Whiteboard Layout Eval ===');
  console.log(`Chat: ${config.chatModel} | Scorer: ${config.scorerModel} | Repeats: ${repeat}`);
  console.log(`Thinking: ${config.enableThinking ? 'ON' : 'OFF'}`);
  console.log('');

  const scenarios = loadScenarios(scenarioFilter);
  if (scenarios.length === 0) {
    console.error('No scenarios found. Check eval/whiteboard-layout/scenarios/');
    process.exit(1);
  }
  console.log(`Loaded ${scenarios.length} scenario(s)`);

  const runDir = createRunDir(outputDir, config.chatModel);
  console.log(`Output: ${runDir}`);

  await initCapture(config.baseUrl);

  const allResults: ScenarioRunResult[] = [];

  for (const scenario of scenarios) {
    console.log(`\nScenario: ${scenario.name} (${scenario.id})`);
    const repeats = scenario.repeat ?? repeat;

    for (let r = 0; r < repeats; r++) {
      const result = await runScenario(scenario, r, runDir, config);
      allResults.push(result);
    }
  }

  await closeCapture();

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    model: config.chatModel,
    scenarios: allResults,
  };

  const { json, md } = generateReport(report, runDir);
  console.log(`\nReport saved:`);
  console.log(`  JSON: ${json}`);
  console.log(`  Markdown: ${md}`);
}

// Run only as the CLI entry point, so tests can import runScenario.
const isEntryPoint =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
