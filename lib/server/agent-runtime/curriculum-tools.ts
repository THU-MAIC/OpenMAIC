/**
 * Multi-stage curriculum tools — the backend half of "user says '7 days of
 * python', ONE agent session runs start to finish": create stages (one class
 * per unit/day), organize them into folders, rename them, and read cross-stage
 * outlines for chaining.
 *
 * Every tool is scoped to the session's owner — a foreign stage/folder is
 * refused fail-closed (never confirming another tenant's id), and every
 * execute takes pi's 3rd `signal` argument and re-checks it at each IO
 * boundary.
 */
import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { DocumentFolderLimitError } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';
import type { StageLinkLifecycleData } from '@/lib/agent-runtime/lifecycle';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { CourseDocument, CourseStore } from './course-tools';
import { folderIdForCall, stageIdForCall } from './course-stage';
import { mergeStageOutline } from './course-outline-union';
import { runStageMutation } from './mutation-fence';
import { FOLDER_COUNT_LIMIT, validateFolderName } from '@/lib/utils/folder-name-validation';

export { stageIdForCall } from './course-stage';

// ── Owner-scoped stage probes ─────────────────────────────────────────────────

/**
 * What one stage is to the session owner. Fail-closed: a foreign course and a
 * missing one are told apart here, but every refusal maps to the same
 * "not yours / not found" tool error — the tool text never echoes which.
 */
export type StageAccess =
  | { kind: 'owned'; stage: { stageId: string; name: string } }
  | { kind: 'missing' | 'foreign' | 'tombstoned' };

interface StageProbeRow extends Record<string, unknown> {
  owner_id: string;
  deleted_at: Date | string | null;
  name: string;
}

/**
 * Probe one stage's existence + ownership + tombstone for the session owner.
 *
 * The ownership boundary is `stage_meta` (the same table the owner-bound
 * document store gates its transactions on): a row claims the stage for its
 * owner, `deleted_at` tombstones it, and the join with `document_stages`
 * yields the display name an owned probe returns. The queryable defaults to
 * the server persistence provider's pool — the runner resolves one per run.
 */
export async function probeStageAccess(
  ownerId: string,
  stageId: string,
  queryable?: Queryable,
): Promise<StageAccess> {
  const db = (queryable ??
    (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).pool) as Queryable;
  const rows = await db.query<StageProbeRow>(
    `SELECT meta.owner_id, meta.deleted_at, stages.name
       FROM stage_meta AS meta
       JOIN document_stages AS stages ON stages.id = meta.stage_id
      WHERE meta.stage_id = $1
      LIMIT 1`,
    [stageId],
  );
  const row = rows.rows[0];
  if (!row) return { kind: 'missing' };
  if (row.owner_id !== ownerId) return { kind: 'foreign' };
  if (row.deleted_at !== null) return { kind: 'tombstoned' };
  return { kind: 'owned', stage: { stageId, name: row.name } };
}

// ── Tool deps ─────────────────────────────────────────────────────────────────

export interface CurriculumToolDeps {
  /** The owner-bound document store of the run's session owner. */
  store: CourseStore;
  /** The session owner; every stage access is scoped to it. */
  ownerId: string;
  sessionId: string;
  /** Probe one stage for the owner (existence + ownership + tombstone). */
  stageAccess: (stageId: string) => Promise<StageAccess>;
  /** Fired whenever a tool produces or returns a classroom link. */
  onStageLink?: (course: StageLinkLifecycleData) => void;
  /**
   * Fired after a successful WRITE to the owner's course library: a stage
   * created. The runner turns it into the durable `library_changed` event and
   * the workspace refetches its course list — the same refresh sink the first
   * committed page already uses.
   *
   * Fired ONLY after the persist succeeded: a refused or failed call changed
   * nothing, and asking the client to refetch a tree that did not move is a
   * request for the same bytes back.
   */
  onLibraryChanged?: (change: LibraryChange) => void;
  /** Fired after a successful stage-document write. */
  onCheckpoint?: (info: {
    tool: string;
    stageId: string;
    detail: string;
    courseTitle?: string;
  }) => void;
}

/**
 * What moved in the library. The client refetches the whole list either way, so
 * this rides along for the log and for debugging rather than for a diff — see
 * `LIFECYCLE.libraryChanged`.
 */
export type LibraryChange =
  | { change: 'stage_created'; stageId: string; title: string }
  | { change: 'folder_created'; folderId: string; name: string }
  | { change: 'stage_moved'; stageId: string; folderId: string }
  | { change: 'stage_renamed'; stageId: string; title: string };

// ── Params ────────────────────────────────────────────────────────────────────

const CreateStageParams = Type.Object({
  title: Type.String({
    description:
      'Stage title (e.g. "Day 1 — Python basics"); becomes the stage name and the `/classroom/<stageId>` title.',
  }),
  brief: Type.Optional(
    Type.String({ description: 'Optional one-line brief, stored as the stage description.' }),
  ),
  folderId: Type.Optional(
    Type.String({
      description:
        'An owner folder id from create_folder or list_folder_stages. Omit to create an ungrouped stage.',
    }),
  ),
});

const CreateFolderParams = Type.Object({
  name: Type.String({ description: 'Folder name with display width at most 40.' }),
});

const MoveToFolderParams = Type.Object({
  stageId: Type.String({ description: 'An owner stage id.' }),
  folderId: Type.String({ description: 'An owner folder id.' }),
});

const RenameStageParams = Type.Object({
  stageId: Type.String({ description: 'An owner stage id.' }),
  name: Type.String({ description: 'New stage name with display width at most 40.' }),
  description: Type.Optional(
    Type.String({ description: 'Optional non-empty replacement stage description.' }),
  ),
});

const ListFolderStagesParams = Type.Object({
  folderId: Type.Optional(
    Type.String({ description: 'Omit to list every stage owned by this session user.' }),
  ),
});

const ReadStageOutlineParams = Type.Object({
  stageId: Type.String({
    description:
      'An owner stage id. Returns the stage title and its page list (order/title/type) — the summary level, not page content.',
  }),
});

// ── Toolset ───────────────────────────────────────────────────────────────────

function toolResult(text: string, details: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * The single refusal every owner-scoped tool maps a non-owned stage to. The
 * tool text never echoes whether the stage is foreign, tombstoned, or missing
 * — a stranger probing another tenant's id gets the same answer they would
 * have got while it was alive.
 */
function notYoursResult(subject: string) {
  return toolResult(
    `${subject} was not found, or does not belong to this session user. Use list_folder_stages to see the stages you can work on.`,
    { refused: true },
    true,
  );
}

export function buildCurriculumTools(deps: CurriculumToolDeps): AgentTool<never, never>[] {
  const createStage: AgentTool<typeof CreateStageParams, unknown> = {
    name: 'create_stage',
    label: 'Create stage',
    description:
      'Create a NEW stage document owned by this session user and return its stageId and classroom url. Pass that stageId explicitly to every later stage tool. Use for multi-stage series: one stage per unit/day.',
    parameters: CreateStageParams,
    async execute(callId, params: Static<typeof CreateStageParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const title = params.title?.trim();
      if (!title) {
        return toolResult('create_stage needs a non-empty title.', { error: 'empty-title' }, true);
      }
      const folderId = params.folderId?.trim() || undefined;
      // Fail loud BEFORE any write: a folderId that is not one of the owner's
      // folders refuses the whole call — never silently mint a stage into
      // "ungrouped" because the folderId was wrong.
      if (folderId) {
        const folders = await deps.store.listFolders();
        if (signal?.aborted) throw new Error('aborted');
        if (!folders.some((folder) => folder.id === folderId)) {
          return toolResult(
            'The folder was not found, or does not belong to this session user. Create it with create_folder first, or omit folderId to create an ungrouped stage.',
            { refused: true, error: 'unknown-folder' },
            true,
          );
        }
      }
      // Idempotent by construction: the SAME tool call (same call id, replayed
      // after a crash between the save and the result checkpoint) derives the
      // SAME stage id, so the retry lands on the stage the original already
      // minted instead of casting a second orphan course. The store is
      // owner-bound. A foreign document at the same id is readable, but its
      // producer marker cannot match this session and the write gate refuses it.
      const stageId = stageIdForCall(deps.sessionId, callId);
      const existing = await deps.store.loadDocument(stageId);
      if (signal?.aborted) throw new Error('aborted');
      if (existing) {
        const producerRef = (existing.outline as AppDocumentOutline | undefined)?.producerRef;
        // `producerRef` is this session's id when the agent created the stage
        // (set below; absent for an empty sessionId). Only a stage this session
        // minted may be treated as a committed retry — a document this session
        // did not mint at the same id is a collision and must not be confirmed.
        const ours = deps.sessionId ? producerRef === deps.sessionId : producerRef === undefined;
        if (!ours) {
          return toolResult(
            `A stage document already exists at this id and was not created by this session; refusing to overwrite it.`,
            { refused: true },
            true,
          );
        }
        if (folderId) {
          const moved = await runStageMutation(signal, () =>
            deps.store.moveDocumentToFolder(stageId, folderId),
          );
          if (signal?.aborted) throw new Error('aborted');
          if (!moved) {
            return toolResult(
              'The folder was not found, or does not belong to this session user; the existing stage could not be filed into it. Use move_to_folder once the folder exists.',
              { refused: true, error: 'unknown-folder' },
              true,
            );
          }
        }
        deps.onStageLink?.({
          stageId,
          title: existing.stage.name,
          url: `/classroom/${stageId}`,
        });
        return toolResult(
          `Stage "${existing.stage.name}" was already created — this create_stage call was a retry, returning the existing stage.`,
          {
            stageId,
            title: existing.stage.name,
            url: `/classroom/${stageId}`,
            ...(folderId ? { folderId } : {}),
            reused: true,
          },
        );
      }
      const now = Date.now();
      const document: CourseDocument = {
        stage: {
          id: stageId,
          name: title,
          ...(params.brief?.trim() ? { description: params.brief.trim() } : {}),
          createdAt: now,
          updatedAt: now,
        },
        scenes: [],
        // The same outline envelope the server-side generate_outline writes,
        // with producer semantics intact: this course is owned by the agent
        // runtime job, and the browser must never generate into it. An
        // agent-minted stage has NO generation-pipeline lifecycle — planning
        // happens in the conversation and each page lands through the page
        // tools of the generation slice — so it is born complete
        // (`generationComplete: true`).
        outline: {
          outlines: [],
          requirement: title,
          generationComplete: true,
          producer: 'server-job',
          ...(deps.sessionId ? { producerRef: deps.sessionId } : {}),
          createdAt: now,
          updatedAt: now,
        } satisfies AppDocumentOutline,
      };
      if (signal?.aborted) throw new Error('aborted');
      // `saveDocument` on the owner-bound store mints the document AND claims
      // the owner scope in one transaction. A concurrent mint of the same id
      // is refused by the store's owner scope; the replay is sequential, so
      // the loadDocument pre-check above is the ordering guarantee.
      await runStageMutation(signal, () => deps.store.saveDocument(document));
      if (signal?.aborted) throw new Error('aborted');
      if (folderId) {
        const moved = await runStageMutation(signal, () =>
          deps.store.moveDocumentToFolder(stageId, folderId),
        );
        if (signal?.aborted) throw new Error('aborted');
        if (!moved) {
          return toolResult(
            `The folder was not found, or does not belong to this session user. Stage "${title}" was created but NOT filed — it currently sits ungrouped. Recreate the folder, then move_to_folder it.`,
            { stageId, title, url: `/classroom/${stageId}`, archived: false },
            true,
          );
        }
      }
      // The owner's library gained a course — the left rail's tree is stale
      // until it refetches. Fired exactly once per mint.
      deps.onLibraryChanged?.({ change: 'stage_created', stageId, title });
      deps.onStageLink?.({ stageId, title, url: `/classroom/${stageId}` });
      return toolResult(
        `Created stage "${title}" — open it at /classroom/${stageId}.${folderId ? ` Filed into folder ${folderId}.` : ''} Pass stageId=${stageId} explicitly to every stage tool for this stage.`,
        {
          stageId,
          title,
          url: `/classroom/${stageId}`,
          ...(folderId ? { folderId, archived: true } : {}),
        },
      );
    },
  };

  const createFolder: AgentTool<typeof CreateFolderParams, unknown> = {
    name: 'create_folder',
    label: 'Create folder',
    description:
      'Create an owner-scoped stage folder. A case-insensitive duplicate reuses the existing folder.',
    parameters: CreateFolderParams,
    async execute(callId, params: Static<typeof CreateFolderParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const name = params.name?.trim() ?? '';
      const validation = validateFolderName(name);
      if (!validation.ok) {
        return toolResult(
          validation.kind === 'empty'
            ? 'Folder name must not be empty.'
            : 'Folder name is too long (display width > 40).',
          { error: validation.kind, width: validation.width },
          true,
        );
      }
      try {
        const created = await runStageMutation(signal, () =>
          deps.store.createFolder(
            folderIdForCall(deps.sessionId, callId),
            name,
            FOLDER_COUNT_LIMIT,
          ),
        );
        if (signal?.aborted) throw new Error('aborted');
        if (!created.reused) {
          deps.onLibraryChanged?.({
            change: 'folder_created',
            folderId: created.folder.id,
            name: created.folder.name,
          });
        }
        return toolResult(
          created.reused
            ? `A folder named "${created.folder.name}" already exists — reusing folderId=${created.folder.id}.`
            : `Created folder "${created.folder.name}" with folderId=${created.folder.id}.`,
          { folderId: created.folder.id, name: created.folder.name, reused: created.reused },
        );
      } catch (error) {
        if (error instanceof DocumentFolderLimitError) {
          return toolResult('Folder count limit reached (50).', { error: 'limit' }, true);
        }
        throw error;
      }
    },
  };

  const moveToFolder: AgentTool<typeof MoveToFolderParams, unknown> = {
    name: 'move_to_folder',
    label: 'Move stage to folder',
    description: 'File an owner stage into an owner folder. Repeating the same move is safe.',
    parameters: MoveToFolderParams,
    async execute(_id, params: Static<typeof MoveToFolderParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const access = await deps.stageAccess(params.stageId);
      if (signal?.aborted) throw new Error('aborted');
      if (access.kind !== 'owned') return notYoursResult(`Stage "${params.stageId}"`);
      const moved = await runStageMutation(signal, () =>
        deps.store.moveDocumentToFolder(params.stageId, params.folderId),
      );
      if (signal?.aborted) throw new Error('aborted');
      if (!moved) {
        return toolResult(
          'The folder was not found, or does not belong to this session user.',
          { refused: true },
          true,
        );
      }
      deps.onLibraryChanged?.({
        change: 'stage_moved',
        stageId: params.stageId,
        folderId: params.folderId,
      });
      return toolResult(`Stage "${access.stage.name}" is now in folder ${params.folderId}.`, {
        stageId: params.stageId,
        folderId: params.folderId,
      });
    },
  };

  const renameStage: AgentTool<typeof RenameStageParams, unknown> = {
    name: 'rename_stage',
    label: 'Rename stage',
    description: 'Rename an owner stage and optionally replace its description.',
    parameters: RenameStageParams,
    executionMode: 'sequential',
    async execute(_id, params: Static<typeof RenameStageParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const name = params.name?.trim() ?? '';
      const validation = validateFolderName(name);
      if (!validation.ok) {
        return toolResult(
          validation.kind === 'empty'
            ? 'rename_stage needs a non-empty name.'
            : 'Stage name is too long (display width > 40).',
          { error: validation.kind === 'empty' ? 'empty-name' : 'name-too-long' },
          true,
        );
      }
      const access = await deps.stageAccess(params.stageId);
      if (signal?.aborted) throw new Error('aborted');
      if (access.kind !== 'owned') return notYoursResult(`Stage "${params.stageId}"`);
      const doc = await deps.store.loadDocument(params.stageId);
      if (signal?.aborted) throw new Error('aborted');
      if (!doc) {
        return toolResult(
          'Course document not found; it may have been deleted.',
          { refused: true },
          true,
        );
      }
      const description = params.description?.trim();
      const renamed = {
        ...doc.stage,
        name,
        updatedAt: Date.now(),
        ...(description ? { description } : {}),
      };
      await runStageMutation(signal, () => deps.store.saveDocument({ ...doc, stage: renamed }));
      if (signal?.aborted) throw new Error('aborted');
      deps.onCheckpoint?.({
        tool: 'rename_stage',
        stageId: params.stageId,
        detail: `renamed to "${name}"`,
        courseTitle: name,
      });
      deps.onLibraryChanged?.({ change: 'stage_renamed', stageId: params.stageId, title: name });
      return toolResult(
        `Renamed stage "${access.stage.name}" to "${name}".${description ? ' Description updated.' : ''}`,
        {
          stageId: params.stageId,
          title: name,
          ...(description ? { description } : {}),
        },
      );
    },
  };

  const listFolderStages: AgentTool<typeof ListFolderStagesParams, unknown> = {
    name: 'list_folder_stages',
    label: 'List stages',
    description: 'List owner stages and their folders, or stages in one owner folder.',
    parameters: ListFolderStagesParams,
    async execute(_id, params: Static<typeof ListFolderStagesParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      if (params.folderId) {
        const folders = await deps.store.listFolders();
        if (signal?.aborted) throw new Error('aborted');
        if (!folders.some((folder) => folder.id === params.folderId)) {
          return toolResult(
            'The folder was not found, or does not belong to this session user.',
            { refused: true },
            true,
          );
        }
      }
      const courses = await deps.store.listDocuments(params.folderId);
      if (signal?.aborted) throw new Error('aborted');
      if (courses.length === 0) return toolResult('No stages found.', { courses: [], count: 0 });
      const details = courses.map((course) => ({
        stageId: course.id,
        title: course.name,
        ...(course.folderId ? { folderId: course.folderId } : {}),
        updatedAt: course.updatedAt,
        pageCount: course.sceneCount,
      }));
      const lines = details
        .map(
          (course) =>
            `- "${course.title}" (${course.stageId}, ${course.pageCount} page(s)${course.folderId ? `, folder ${course.folderId}` : ''})`,
        )
        .join('\n');
      return toolResult(`Stages:\n${lines}`, { courses: details, count: details.length });
    },
  };

  const readStageOutline: AgentTool<typeof ReadStageOutlineParams, unknown> = {
    name: 'read_stage_outline',
    label: 'Read stage outline',
    description:
      'Read the OUTLINE of any stage this session user owns (title + page list with order/title/type — not page content). Use to chain stages in a series: see what a previous day covered before planning the next.',
    parameters: ReadStageOutlineParams,
    async execute(_id, params: Static<typeof ReadStageOutlineParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const access = await deps.stageAccess(params.stageId);
      if (signal?.aborted) throw new Error('aborted');
      if (access.kind !== 'owned') return notYoursResult(`Stage "${params.stageId}"`);
      const doc = await deps.store.loadDocument(params.stageId);
      if (signal?.aborted) throw new Error('aborted');
      if (!doc) {
        return toolResult(
          'Course document not found; it may have been deleted.',
          { refused: true },
          true,
        );
      }
      const snapshot = doc.outline as AppDocumentOutline | undefined;
      const planned = snapshot && Array.isArray(snapshot.outlines) ? snapshot.outlines : [];
      const scenes = doc.scenes ?? [];
      // UNION view: real scenes pair with the outline entries they were built
      // from (outlineId, then order) and planned-only pages stay visible at
      // their planned position while generation is in progress; a COMPLETED
      // snapshot is pure scenes. See course-outline-union.ts.
      const entries = mergeStageOutline({
        scenes,
        planned,
        generationComplete: snapshot?.generationComplete,
      });
      // `details.pages` keeps the historical {order,title,type} shape; the
      // planned/pending marker and the display sequence ride the
      // human-readable text only (display numbers are the merged consecutive
      // positions — entries keep their original order).
      const pages = entries.map(({ order, title, type }) => ({ order, title, type }));
      const title = doc.stage?.name ?? '';
      const text =
        pages.length === 0
          ? `Stage "${title}" has no planned pages yet.`
          : `Stage "${title}" (${pages.length} page(s)):\n${entries
              .map((p, i) => `- ${i + 1}. ${p.title} [${p.type}]${p.planned ? ' (planned)' : ''}`)
              .join('\n')}`;
      return toolResult(text, { stageId: params.stageId, title, pages, pageCount: pages.length });
    },
  };

  return [
    createStage,
    createFolder,
    moveToFolder,
    renameStage,
    listFolderStages,
    readStageOutline,
  ] as unknown as AgentTool<never, never>[];
}

export const CURRICULUM_ALLOWLIST: ReadonlySet<string> = new Set([
  'create_stage',
  'create_folder',
  'move_to_folder',
  'rename_stage',
  'list_folder_stages',
  'read_stage_outline',
]);

/**
 * Prompt block teaching the multi-stage workflow (appended to the system
 * prompt).
 */
export const CURRICULUM_TOOLS_PROMPT = [
  'Multi-stage series: create the series folder with `create_folder`, then call',
  '`create_stage` once per unit/day and pass the folderId in the same call.',
  '`create_stage` returns a stageId; pass that',
  'stageId explicitly to every later stage tool. There is no active/current stage.',
  'Use different stageIds to work on several stages in parallel.',
  '`list_folder_stages` lists stages and folder membership; `move_to_folder`',
  're-files a stage; `rename_stage` changes its classroom title.',
  "`read_stage_outline` reads a stage's page list (not content) so you can",
  'chain a series (e.g. day 2 builds on what day 1 covered).',
].join(' ');
