/** Shared types for the orchestration evals (answering, answer-content). */

/** A minimal agent description from a scenario fixture. */
export interface ScenarioAgent {
  id: string;
  name: string;
  role: string;
  priority: number;
}
