/**
 * Folders and folder membership from the old database.
 *
 * Folder ids are minted by the server, so a legacy folder maps to a server
 * folder by name: one this owner already has under that name is reused (a
 * second import, or a folder the user recreated by hand, does not duplicate),
 * otherwise one is created. The mapping is kept in the ledger.
 */
import type { FolderRecord } from '@/lib/types/folder';
import { FolderNameError } from '@/lib/utils/folder-name-validation';
import { readLegacyFolders, readLegacyStageFolders } from '@/lib/legacy-browser-storage';

import { failureOrStop } from './errors';
import type { ImportLedger } from './ledger';

/** The owner-scoped folder routes, as the importer uses them. */
export interface FolderApi {
  list(): Promise<FolderRecord[]>;
  create(name: string): Promise<FolderRecord>;
  setMembership(stageId: string, folderId: string): Promise<void>;
}

/**
 * Map every legacy folder to a server folder. A transient failure leaves that
 * folder pending (and is reported); anything else settles it.
 */
export async function importFolders(
  ledger: ImportLedger,
  api: FolderApi,
  checkpoint: () => void,
): Promise<{ pending: number; created: number }> {
  const legacy = await readLegacyFolders();
  let server: FolderRecord[] | undefined;
  let pending = 0;
  let created = 0;
  for (const folder of legacy) {
    const entry = (ledger.folders[folder.id] ??= { status: 'pending' });
    if (entry.status !== 'pending') continue;
    try {
      server ??= await api.list();
      const existing = server.find((candidate) => candidate.name === folder.name);
      if (existing) {
        Object.assign(entry, { status: 'done', serverId: existing.id });
      } else {
        let made: FolderRecord;
        try {
          made = await api.create(folder.name);
          created += 1;
        } catch (error) {
          if (!(error instanceof FolderNameError) || error.kind !== 'duplicate') throw error;
          // Created concurrently (another tab of this owner): use that one.
          server = await api.list();
          const raced = server.find((candidate) => candidate.name === folder.name);
          if (!raced) throw error;
          made = raced;
        }
        server.push(made);
        Object.assign(entry, { status: 'done', serverId: made.id });
      }
    } catch (error) {
      if (error instanceof FolderNameError) {
        // The name no longer passes validation, or the owner is at the folder
        // limit: the folder is not created and its courses stay unfiled.
        Object.assign(entry, { status: 'failed', reason: `folder ${error.kind}` });
      } else {
        const failure = failureOrStop(error);
        if (failure.kind === 'transient') {
          pending += 1;
          entry.reason = failure.reason;
        } else {
          Object.assign(entry, { status: 'failed', reason: failure.reason });
        }
      }
    }
    checkpoint();
  }
  return { pending, created };
}

/** The legacy folder each course was filed in, by legacy course id. */
export async function legacyMembership(): Promise<Map<string, string>> {
  const membership = new Map<string, string>();
  for (const row of await readLegacyStageFolders()) {
    if (row.folderId) membership.set(row.stageId, row.folderId);
  }
  return membership;
}
