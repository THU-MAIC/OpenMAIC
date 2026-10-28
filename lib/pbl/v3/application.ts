/** Observations are not formal test results or learner approvals. */
export interface ApplicationObservation {
  observedAt: string;
  state: 'stopped' | 'starting' | 'running' | 'failed' | 'unknown';
  commandState?: string;
  exitCode?: number | null;
  httpStatus?: number;
  sourceChanged?: boolean;
  output?: string;
  preview?: { url: string; expiresAt: number };
}

export const APPLICATION_CAPABILITY = 'pbl-v3-application@1';
