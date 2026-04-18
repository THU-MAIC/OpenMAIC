import type { PPTElement } from '@/lib/types/slides';
import type { Stage, Scene } from '@/lib/types/stage';

// ==================== Scenario ====================

export interface EvalTurn {
  userMessage: string;
  checkpoint?: boolean;
}

export interface EvalScenario {
  id: string;
  name: string;
  description: string;
  tags: string[];
  initialStoreState: {
    stage: Stage | null;
    scenes: Scene[];
    currentSceneId: string | null;
    whiteboardElements?: PPTElement[];
  };
  config: {
    agentIds: string[];
    sessionType: 'qa' | 'discussion';
  };
  turns: EvalTurn[];
  model?: string;
  repeat?: number;
}

// ==================== Scoring ====================

export interface DimensionScore {
  score: number;
  reason: string;
}

export interface VlmScore {
  readability: DimensionScore;
  overlap: DimensionScore;
  rendering_correctness: DimensionScore;
  content_completeness: DimensionScore;
  layout_logic: DimensionScore;
  overall: number;
  issues: string[];
}

// ==================== Results ====================

export interface CheckpointResult {
  turnIndex: number;
  screenshotPath: string;
  /** null when VLM scoring failed — screenshot is still preserved. */
  score: VlmScore | null;
  elements: PPTElement[];
}

export interface ScenarioRunResult {
  scenarioId: string;
  runIndex: number;
  model: string;
  checkpoints: CheckpointResult[];
  error?: string;
}

export interface EvalReport {
  timestamp: string;
  model: string;
  scenarios: ScenarioRunResult[];
}
