import type {
  AgentRole,
  CourseReleaseDescriptor,
  ProjectDefinition,
  StageDefinition,
  WorkspaceAccessPolicy,
} from '../project/project-schema';
import type { DecisionRecord } from './decisions';

export type SessionStatus =
  | 'created'
  | 'running'
  | 'waiting_for_student'
  | 'paused'
  | 'completed'
  | 'failed';
export type MilestoneStatus = 'pending' | 'active' | 'completed' | 'failed';
export type EvaluationFailureKind =
  | 'compile'
  | 'assertion'
  | 'build'
  | 'timeout'
  | 'infrastructure'
  | 'contract'
  | 'decision'
  | 'plan'
  | 'unknown';

export interface PublicEvaluationDiagnosticLocation {
  file: string;
  line?: number;
  code:
    | 'cannot_find_symbol'
    | 'type_mismatch'
    | 'invalid_method_call'
    | 'missing_package'
    | 'compile_error';
}

export interface PublicEvaluationDiagnostics {
  kind: EvaluationFailureKind;
  summary: string;
  reportGenerated: boolean;
  locations?: PublicEvaluationDiagnosticLocation[];
  checks?: string[];
  /** Safe public case metadata only; never expected values, scripts or raw tracebacks. */
  caseResults?: {
    id: string;
    label: string;
    passed: boolean;
    reason?: 'output' | 'execution' | 'timeout' | 'environment' | 'not_run';
  }[];
}

export interface WorkspaceRevision {
  id: string;
  provider: 'local-snapshot' | 'git' | 'sandbox';
  createdAt: string;
  parentId?: string;
  checkpoint?: string;
}

export interface RemediationHint {
  id: string;
  kind: 'implementation_repair';
  target: 'coder';
  reason: string;
  attempt: number;
  evaluationId: string;
  safeFeedback?: string;
}

export interface EvaluationResult {
  id: string;
  status: 'passed' | 'failed' | 'error';
  evaluator: string;
  milestoneId: string;
  stageIndex: number;
  revision: WorkspaceRevision;
  decisionRecordIds: string[];
  planArtifactId?: string;
  codeArtifactId?: string;
  startedAt: string;
  completedAt: string;
  failureKind?: EvaluationFailureKind;
  publicFeedback?: string;
  publicDiagnostics?: PublicEvaluationDiagnostics;
  internalDiagnostics?: string;
  remediation?: RemediationHint;
  reportRef?: string;
}

interface ArtifactRecordBase {
  id: string;
  milestoneId: string;
  revision: number;
  workspaceRevisionId?: string;
}

export type PlanArtifactRecord = ArtifactRecordBase & {
  kind: 'plan';
  /** Hash of the canonical PLAN.md. The plan body lives only in the workspace file. */
  contentHash: string;
  /** Length of the complete approved plan, independent of clipped report evidence. */
  contentLength?: number;
};

export type CodeArtifactRecord = ArtifactRecordBase & {
  kind: 'code';
  value: string;
};

export type ArtifactRecord = PlanArtifactRecord | CodeArtifactRecord;

export interface QuizAttempt {
  id: string;
  attempt: number;
  passed: boolean;
  score: number;
  total: number;
  wrong: number[];
  review?: Array<{
    questionIndex: number;
    correctAnswer: number;
    explanation: string;
  }>;
}

export interface CollectedMilestoneState {
  teachingCompleted?: boolean;
  recapCompleted?: boolean;
  planReviewCompleted?: boolean;
  codeReviewCompleted?: boolean;
  decisions: DecisionRecord[];
  decisionRecordIds: Record<string, string>;
  plan: PlanArtifactRecord | null;
  code: CodeArtifactRecord | null;
  tests: EvaluationResult | null;
  quiz: QuizAttempt | null;
  remediation: RemediationHint | null;
}

export interface MilestoneProgress {
  milestoneId: string;
  status: MilestoneStatus;
  stageIndex: number;
  completedStageIndexes: number[];
  skippedStageIndexes?: number[];
  evaluationIds: string[];
}

export interface SessionPosition {
  milestoneIndex: number;
  milestoneId: string | null;
  stageIndex: number;
  activeAgent?: AgentRole;
  activeAgentId?: string;
}

export type CourseLifecycleStatus = 'pending' | 'preparing' | 'ready' | 'completed' | 'error';

export interface CourseProgress {
  courseId: string;
  milestoneId: string;
  stageIndex: number;
  release: CourseReleaseDescriptor;
  status: CourseLifecycleStatus;
  updatedAt?: string;
  readyAt?: string;
  completedAt?: string;
  errorCode?: string;
}

export interface PblSessionState {
  /** Absent only in legacy snapshots before definition-aware migrations. */
  projectDefinitionRevision?: number;
  /** Pins the intro selected when this Session was created; absent means the legacy project intro. */
  releaseOnboardingId?: string;
  /** Immutable Project Release identity exposed to trusted Session clients. */
  projectRelease?: {
    projectReleaseId: string;
    manifestSha256: string;
    capabilities: string[];
  };
  status: SessionStatus;
  /**
   * Number of times this Session has reached the end of the Project Release it
   * was running at the time.
   *
   * A later append-only release may reopen a completed Session without erasing
   * that historical completion. Reports key their generation to this counter,
   * so an M4 report cannot be mistaken for the final report after M5 is done.
   * Absent only in snapshots written before append-only releases existed.
   */
  completionRevision?: number;
  introCompleted: boolean;
  position: SessionPosition;
  milestones: MilestoneProgress[];
  collected: Record<string, CollectedMilestoneState>;
  courses?: Record<string, CourseProgress>;
  decisionRevisions: Record<string, number>;
  workspaceRevision?: WorkspaceRevision;
  lastSequence: number;
}

export interface LearningSession {
  id: string;
  runtimeId: string;
  sandboxId: string;
  projectId: ProjectDefinition['id'];
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  state: PblSessionState;
}

export interface RuntimeConnectionDescriptor {
  sessionId: string;
  runtimeId: string;
  sandboxId: string;
  transport: 'websocket';
  url: string;
  ticket: string;
  expiresAt: string;
  protocolVersion: 3;
}

export type ActorContext =
  | { actor: 'student'; studentId: string }
  | { actor: 'agent'; role: AgentRole; runId: string }
  | { actor: 'system'; component: 'control-plane' | 'runtime' | 'workspace' }
  | { actor: 'evaluator'; evaluatorId: string; evaluationId: string };

export interface StageExecutionContext {
  session: LearningSession;
  stage: StageDefinition;
  actor: ActorContext;
  workspacePolicy: WorkspaceAccessPolicy;
}
