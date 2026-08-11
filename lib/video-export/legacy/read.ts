/**
 * Read-only video-export support for PBL v1 scenes stored before the v2 cutover.
 *
 * This module is kept indefinitely so historical scenes remain exportable.
 * Writers must never import it to create or project legacy PBL shapes.
 */
type UnknownRecord = Record<string, unknown>;

interface LegacyPblCover {
  kind: 'pbl-cover';
  startMs: number;
  durationMs: number;
  title: string;
  description: string;
  gains: string[];
  stageCount: number;
  taskCount: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): value is UnknownRecord[] {
  return Array.isArray(value) && value.every(isRecord);
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * Mirrors `hasPBLProjectV2Containers` (lib/pbl/v2/types.ts) in full, not just
 * the containers the cover reads: on a hybrid scene, renderer and export must
 * agree on whether the v2 payload is authoritative over the legacy config, or
 * the classroom would fall back to legacy data while the exported video still
 * shows the damaged v2 project. (For v2-only scenes the cover stays permissive;
 * see `pblCover` in passes/visuals.ts.)
 */
export function hasPblV2CoverContainers(value: unknown): value is UnknownRecord {
  if (
    !isRecord(value) ||
    !isRecordArray(value.milestones) ||
    !isRecordArray(value.roles) ||
    !isRecordArray(value.submissions) ||
    !isRecordArray(value.evaluations) ||
    !isRecordArray(value.threads) ||
    !isRecordArray(value.engagementEvents)
  ) {
    return false;
  }
  if (value.milestones.some((milestone) => !isRecordArray(milestone.microtasks))) return false;
  if (value.threads.some((thread) => !isRecordArray(thread.messages))) return false;
  if (value.gains !== undefined && !Array.isArray(value.gains)) return false;
  if (value.runtimeEvents !== undefined && !isRecordArray(value.runtimeEvents)) return false;
  if (
    value.scenario !== undefined &&
    (!isRecord(value.scenario) || !isRecordArray(value.scenario.characters))
  ) {
    return false;
  }
  return true;
}

/**
 * Mirrors `isRunnablePBLProjectV2` for the dependency-isolated export path.
 * Container validity alone is not enough for hybrid precedence: the workspace
 * also needs the Instructor id used for thread binding, every microtask id used
 * by lookup/update paths, and the role/task labels that runtime cannot invent.
 */
export function isRunnablePblV2CoverProject(value: unknown): value is UnknownRecord {
  if (!hasPblV2CoverContainers(value)) return false;

  const milestones = records(value.milestones);
  return (
    records(value.roles).some(
      (role) =>
        role.type === 'instructor' &&
        typeof role.id === 'string' &&
        role.id.trim().length > 0 &&
        typeof role.name === 'string',
    ) &&
    milestones.length > 0 &&
    milestones.every((milestone) => {
      const microtasks = records(milestone.microtasks);
      return (
        microtasks.length > 0 &&
        microtasks.every(
          (microtask) =>
            typeof microtask.id === 'string' &&
            microtask.id.trim().length > 0 &&
            typeof microtask.title === 'string',
        )
      );
    })
  );
}

/**
 * Mirrors the resolver's usable-legacy verdict for the hybrid fallback decision
 * in passes/visuals.ts: a legacy config only overrides a non-runnable v2 payload
 * when the renderer would actually show it — structurally sound containers,
 * non-empty content, and at least one runnable issue. An empty, issue-less, or
 * garbage legacy stub must not discard recoverable v2 cover fields.
 */
export function isUsableLegacyCoverConfig(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  const projectInfo = value.projectInfo;
  if (!isRecord(projectInfo)) return false;
  if (
    !Array.isArray(value.agents) ||
    value.agents.some(
      (agent) => !isRecord(agent) || (agent.name != null && typeof agent.name !== 'string'),
    )
  ) {
    return false;
  }
  if (value.selectedRole != null && typeof value.selectedRole !== 'string') return false;
  const issueboard = value.issueboard;
  if (!isRecord(issueboard) || !isRecordArray(issueboard.issues)) return false;
  const chat = value.chat;
  if (!isRecord(chat) || !isRecordArray(chat.messages)) return false;
  // Raw truthiness, not trimmed text: `isEmptyLegacyPBLConfig` treats a
  // whitespace-only title as content. The explicit issue requirement mirrors
  // resolvePBLContent without changing that broader "has any data" predicate.
  return (
    issueboard.issues.length > 0 &&
    Boolean(
      projectInfo.title ||
      projectInfo.description ||
      value.agents.length > 0 ||
      issueboard.issues.length > 0 ||
      chat.messages.length > 0,
    )
  );
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function legacyIssueRoot(
  issue: UnknownRecord,
  issueById: ReadonlyMap<unknown, UnknownRecord>,
): UnknownRecord | undefined {
  let current = issue;
  const visited = new Set<UnknownRecord>();

  while (current.parent_issue !== null) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const parent = issueById.get(current.parent_issue);
    if (!parent) return undefined;
    current = parent;
  }

  return current;
}

function legacyStageCount(issues: readonly UnknownRecord[]): number {
  const issueById = new Map<unknown, UnknownRecord>();
  for (const issue of issues) issueById.set(issue.id, issue);

  const roots = new Set<UnknownRecord>();
  let standaloneCount = 0;
  for (const issue of issues) {
    const root = legacyIssueRoot(issue, issueById);
    if (root) roots.add(root);
    else standaloneCount += 1;
  }
  return roots.size + standaloneCount;
}

/**
 * A legacy (v1) project has no instructor to put on the cover, so it never
 * names one.
 *
 * Its roster is the 2–4 *development roles the learner chooses between* — the
 * design prompt asks for "Data Analyst", "Frontend Developer" and the like —
 * plus the `Question Agent - <issue>` / `Judge Agent - <issue>` helpers the
 * issueboard spawns per issue. Promoting any of them would print a student
 * role, or a machine name, under a "Tutor" label. Picking by the issueboard's
 * active issue would additionally tie the cover to learner progress. Both are
 * worse than the card simply not claiming an instructor.
 */
export function pblLegacyCover(
  project: unknown,
  scene: { title: string },
  timeline: { startMs: number; durationMs: number },
): LegacyPblCover {
  const legacyProject = isRecord(project) ? project : {};
  const projectInfo = isRecord(legacyProject.projectInfo) ? legacyProject.projectInfo : {};
  const issueboard = isRecord(legacyProject.issueboard) ? legacyProject.issueboard : {};
  const issues = records(issueboard.issues);
  return {
    kind: 'pbl-cover',
    startMs: timeline.startMs,
    durationMs: timeline.durationMs,
    title: text(projectInfo.title) ?? scene.title,
    description: text(projectInfo.description) ?? '',
    gains: [],
    stageCount: legacyStageCount(issues),
    taskCount: issues.length,
  };
}
