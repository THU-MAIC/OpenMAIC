export interface ScenarioAgent {
  id: string;
  name: string;
  role: string;
  priority: number;
}

export interface DirectorScenario {
  case_id: string;
  category: string;
  description: string;
  input: {
    agents: ScenarioAgent[];
    conversationSummary: string;
    agentResponses: Array<{
      agentId: string;
      agentName: string;
      contentPreview: string;
      actionCount: number;
    }>;
    turnCount: number;
    discussionContext?: { topic: string; prompt?: string } | null;
    userProfile?: { nickname?: string; bio?: string };
    whiteboardOpen?: boolean;
  };
  expected: {
    shouldEnd: boolean;
  };
}

export interface JudgeResult {
  pass: boolean;
  reason: string;
}

export interface EvalResult {
  case_id: string;
  category: string;
  description: string;
  directorOutput: string;
  shouldEnd: boolean;
  judgePassed: boolean;
  judgeReason: string;
}
