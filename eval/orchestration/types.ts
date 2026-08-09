/**
 * Types for the orchestration premature-END regression eval.
 *
 * The eval probes whether the director picks END inappropriately when the
 * latest student turn is an unresolved question. Each scenario is run twice:
 *   - "pre-fix"  : director system.md with rules 10/11/12 stripped (#554's adds)
 *   - "post-fix" : the current system.md
 * For every (scenario, variant) pair we draw N samples and tally END decisions.
 */

import type { OpenAIMessage } from '@/lib/orchestration/summarizers/conversation-summary';
import type { AgentTurnSummary } from '@/lib/orchestration/types';

/** A minimal agent description for the director — full AgentConfig is overkill here. */
export interface ScenarioAgent {
  id: string;
  name: string;
  role: string;
  priority: number;
}

export interface Scenario {
  case_id: string;
  description: string;
  /** Director-path messages: role:'user' = human, role:'assistant' = agent. */
  messages: OpenAIMessage[];
  agents: ScenarioAgent[];
  agentResponses: AgentTurnSummary[];
  turnCount: number;
  discussionContext?: { topic: string; prompt?: string } | null;
  triggerAgentId?: string | null;
  whiteboardOpen?: boolean;
  userProfile?: { nickname?: string; bio?: string };
}

export type PromptVariant = 'pre-fix' | 'post-fix';

export interface SampleResult {
  variant: PromptVariant;
  raw: string;
  /** Parsed value: 'END' if director chose END, otherwise the agent id or 'USER'. */
  decision: 'END' | 'USER' | string;
  isEnd: boolean;
  error?: string;
}

export interface ScenarioResult {
  case_id: string;
  description: string;
  samples: number;
  preFix: { endRate: number; samples: SampleResult[] };
  postFix: { endRate: number; samples: SampleResult[] };
  /** Did the fix discriminate on this scenario by ≥ delta threshold? Informational. */
  discriminates: boolean;
  delta: number;
  /** True if post-fix END rate is at or below the regression threshold. */
  postFixPasses: boolean;
}

export interface EvalReport {
  model: string;
  samplesPerVariant: number;
  thresholdDelta: number;
  postFixEndThreshold: number;
  results: ScenarioResult[];
  anyDiscriminates: boolean;
  allPostFixPass: boolean;
}
