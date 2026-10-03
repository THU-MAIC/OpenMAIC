/**
 * The agent's tools for organizing the material library (RFC #1716 §5): list
 * and create folders, rename a folder or a material, move materials. Thin
 * adapters over the shared operations in `lib/persistence/material-library.ts`,
 * which the library page's routes call too.
 *
 * Every write is the run's: it takes the forwarded fence (`'background'`), so
 * a run whose owner is claimed mid-run keeps organizing the account's library
 * the materials moved to. The owner is the run's, never a parameter. The
 * agent cannot delete anything: deleting a material or a folder is the
 * teacher's, on the library page.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

import {
  createMaterialFolder,
  listMaterialFolders,
  MAX_MOVE_MATERIALS,
  moveMaterials,
  renameMaterial,
  renameMaterialFolder,
} from '@/lib/persistence/material-library';
import { canonicalizeStoredOwner } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

const LIST_FOLDERS_SCHEMA = Type.Object({
  query: Type.Optional(
    Type.String({ minLength: 1, maxLength: 200, description: 'Literal text to match in names.' }),
  ),
});
const CREATE_FOLDER_SCHEMA = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80, description: 'The folder name.' }),
});
const RENAME_FOLDER_SCHEMA = Type.Object({
  folderId: Type.String({ description: 'The folderId from list_material_folders.' }),
  name: Type.String({ minLength: 1, maxLength: 80, description: 'The new name.' }),
});
const MOVE_SCHEMA = Type.Object({
  materialIds: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: MAX_MOVE_MATERIALS,
    uniqueItems: true,
    description:
      'Source material ids. Their derivatives move with them; a derivative cannot be moved on its own.',
  }),
  folderId: Type.Union([Type.String(), Type.Null()], {
    description: 'The target folderId, or null to move the materials back to Unfiled.',
  }),
});
const RENAME_MATERIAL_SCHEMA = Type.Object({
  materialId: Type.String({ description: 'A source material id.' }),
  name: Type.String({ minLength: 1, maxLength: 255, description: 'The new display name.' }),
});

export const MATERIAL_LIBRARY_TOOL_NAMES = [
  'list_material_folders',
  'create_material_folder',
  'rename_material_folder',
  'move_materials',
  'rename_material',
] as const;

/**
 * A change the run made to the material library, sent as the durable
 * `library_changed` event with `library: 'materials'` (RFC #1716 §7): what
 * lists materials refetches. Only actual changes are sent -- a call that
 * changed nothing, or was refused, sends none.
 */
export type MaterialLibraryChange = { library: 'materials' } & (
  | { change: 'folder_created' | 'folder_renamed'; folderId: string }
  | { change: 'materials_moved'; materialIds: string[]; folderId: string | null }
  | { change: 'material_renamed'; materialId: string }
  | { change: 'extraction_started' | 'extraction_settled'; materialIds: string[] }
);

export interface MaterialLibraryToolDependencies {
  /** The run's owner as recorded on its session; claims are followed. */
  ownerId: string;
  onLibraryChanged?: (change: MaterialLibraryChange) => void;
}

function result(details: Record<string, unknown>, text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

async function persistence() {
  return getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('aborted');
}

const FOLDER_NAME_REASONS: Record<string, string> = {
  empty: 'The folder name is empty.',
  tooLong: 'The folder name is too long (at most 40 half-width or 20 full-width characters).',
};

export function buildMaterialLibraryTools(
  deps: MaterialLibraryToolDependencies,
): AgentTool<never, never>[] {
  const write = { ownerId: deps.ownerId, fence: 'background' as const };

  const listFolders: AgentTool<typeof LIST_FOLDERS_SCHEMA> = {
    name: 'list_material_folders',
    label: 'List knowledge base folders',
    description:
      "List the folders of the user's knowledge base, with how many materials each holds. " +
      'Materials outside every folder are Unfiled (folderId null).',
    parameters: LIST_FOLDERS_SCHEMA,
    execute: async (_callId, params, signal) => {
      throwIfAborted(signal);
      const owner = await canonicalizeStoredOwner(deps.ownerId);
      const folders = (
        await listMaterialFolders((await persistence()).pool, owner, {
          ...(params.query ? { query: params.query } : {}),
        })
      ).map((folder) => ({
        folderId: folder.id,
        name: folder.name,
        materialCount: folder.materialCount,
      }));
      return result(
        { status: 'listed', folders },
        folders.length ? JSON.stringify(folders, null, 2) : 'No folders yet.',
      );
    },
  };

  const createFolder: AgentTool<typeof CREATE_FOLDER_SCHEMA> = {
    name: 'create_material_folder',
    label: 'Create knowledge base folder',
    description:
      'Create a folder in the knowledge base. A folder of the same name (ignoring case) is ' +
      'returned instead of a second one (created: false).',
    parameters: CREATE_FOLDER_SCHEMA,
    execute: async (_callId, params, signal) => {
      throwIfAborted(signal);
      const outcome = await createMaterialFolder(await persistence(), {
        ...write,
        name: params.name,
      });
      if (outcome.status === 'invalid_name') {
        return result({ status: 'invalid_name' }, FOLDER_NAME_REASONS[outcome.reason]!, true);
      }
      if (outcome.status === 'limit') {
        return result(
          { status: 'limit', limit: outcome.limit },
          `The knowledge base already has the maximum of ${outcome.limit} folders.`,
          true,
        );
      }
      if (outcome.created) {
        deps.onLibraryChanged?.({
          library: 'materials',
          change: 'folder_created',
          folderId: outcome.folder.id,
        });
      }
      const details = {
        status: outcome.created ? 'created' : 'exists',
        folderId: outcome.folder.id,
        name: outcome.folder.name,
        created: outcome.created,
      };
      return result(details, JSON.stringify(details, null, 2));
    },
  };

  const renameFolder: AgentTool<typeof RENAME_FOLDER_SCHEMA> = {
    name: 'rename_material_folder',
    label: 'Rename knowledge base folder',
    description: 'Rename a knowledge-base folder. Renaming to its current name changes nothing.',
    parameters: RENAME_FOLDER_SCHEMA,
    execute: async (_callId, params, signal) => {
      throwIfAborted(signal);
      const outcome = await renameMaterialFolder(await persistence(), {
        ...write,
        folderId: params.folderId,
        name: params.name,
      });
      switch (outcome.status) {
        case 'invalid_name':
          return result({ status: 'invalid_name' }, FOLDER_NAME_REASONS[outcome.reason]!, true);
        case 'not_found':
          return result({ status: 'not_found' }, 'Folder not found.', true);
        case 'name_taken':
          return result({ status: 'name_taken' }, 'Another folder already has that name.', true);
        default: {
          if (outcome.status === 'renamed') {
            deps.onLibraryChanged?.({
              library: 'materials',
              change: 'folder_renamed',
              folderId: outcome.folder.id,
            });
          }
          const details = {
            status: outcome.status,
            folderId: outcome.folder.id,
            name: outcome.folder.name,
          };
          return result(details, JSON.stringify(details, null, 2));
        }
      }
    },
  };

  const move: AgentTool<typeof MOVE_SCHEMA> = {
    name: 'move_materials',
    label: 'Move knowledge base materials',
    description:
      'Move source materials, with their derivatives, into a folder, or back to Unfiled with ' +
      'folderId null. All or nothing: if one cannot move, none does.',
    parameters: MOVE_SCHEMA,
    execute: async (_callId, params, signal) => {
      throwIfAborted(signal);
      const outcome = await moveMaterials(await persistence(), {
        ...write,
        materialIds: params.materialIds,
        folderId: params.folderId,
      });
      switch (outcome.status) {
        case 'folder_not_found':
          return result({ status: 'folder_not_found' }, 'Folder not found.', true);
        case 'not_movable':
          return result(
            { status: 'not_movable', materialIds: outcome.materialIds },
            `Nothing was moved. These ids are not source materials of the knowledge base: ${outcome.materialIds.join(', ')}.`,
            true,
          );
        case 'too_many':
          return result(
            { status: 'too_many', limit: outcome.limit },
            `Move at most ${outcome.limit} materials at a time.`,
            true,
          );
        default: {
          if (outcome.status === 'moved') {
            deps.onLibraryChanged?.({
              library: 'materials',
              change: 'materials_moved',
              materialIds: outcome.materialIds,
              folderId: outcome.folderId,
            });
          }
          const details = {
            status: outcome.status,
            materialIds: outcome.materialIds,
            folderId: outcome.folderId,
            movedCount: outcome.movedCount,
          };
          return result(details, JSON.stringify(details, null, 2));
        }
      }
    },
  };

  const renameSource: AgentTool<typeof RENAME_MATERIAL_SCHEMA> = {
    name: 'rename_material',
    label: 'Rename knowledge base material',
    description:
      "Rename a source material's display name; the uploaded file name is kept. Derivatives are " +
      'named after their source and cannot be renamed.',
    parameters: RENAME_MATERIAL_SCHEMA,
    execute: async (_callId, params, signal) => {
      throwIfAborted(signal);
      const outcome = await renameMaterial(await persistence(), {
        ...write,
        materialId: params.materialId,
        name: params.name,
      });
      switch (outcome.status) {
        case 'invalid_name':
          return result({ status: 'invalid_name' }, 'The name is empty or too long.', true);
        case 'not_found':
          return result({ status: 'not_found' }, 'Material not found.', true);
        case 'derivative':
          return result(
            { status: 'derivative' },
            'A derivative is named after its source; rename the source instead.',
            true,
          );
        default:
          if (outcome.status === 'renamed') {
            deps.onLibraryChanged?.({
              library: 'materials',
              change: 'material_renamed',
              materialId: outcome.materialId,
            });
          }
          return result({ ...outcome }, JSON.stringify(outcome, null, 2));
      }
    },
  };

  return [listFolders, createFolder, renameFolder, move, renameSource] as unknown as AgentTool<
    never,
    never
  >[];
}
