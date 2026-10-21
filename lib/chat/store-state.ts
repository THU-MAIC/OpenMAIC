/** Store state snapshot sent with each classroom chat request */
export interface AgentLoopStoreState {
  stage: unknown;
  scenes: unknown[];
  outlines?: unknown[];
  currentSceneId: string | null;
  mode: string;
  whiteboardOpen: boolean;
  whiteboardManualVisibilityRevision?: number;
  /**
   * Post-submit quiz state for the current scene. Hydrated from RuntimeStore
   * client-side; absent when the active scene is not a graded quiz or the
   * student has not submitted yet.
   */
  quizResults?: {
    sceneId: string;
    answers: Record<string, string | string[]>;
    results: Array<{
      questionId: string;
      correct: boolean | null;
      status: 'correct' | 'incorrect';
      earned: number;
      aiComment?: string;
    }>;
  };
}
