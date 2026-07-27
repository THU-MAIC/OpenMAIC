import Dexie, { type Table } from 'dexie';
import type { DocumentBridgeLedgerEntry } from './types';

class DocumentBridgeLedgerDatabase extends Dexie {
  entries!: Table<DocumentBridgeLedgerEntry, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({ entries: '&courseId, status, sourceHash, updatedAt' });
  }
}

const ledgers = new Map<string, DocumentBridgeLedgerDatabase>();

function getLedger(namespace: string): DocumentBridgeLedgerDatabase {
  const name = `rj-document-bridge-v1-${namespace}`;
  let ledger = ledgers.get(name);
  if (!ledger) {
    ledger = new DocumentBridgeLedgerDatabase(name);
    ledgers.set(name, ledger);
  }
  return ledger;
}

export async function getBridgeEntry(namespace: string, courseId: string) {
  return getLedger(namespace).entries.get(courseId);
}

export async function putBridgeEntry(namespace: string, entry: DocumentBridgeLedgerEntry) {
  await getLedger(namespace).entries.put(entry);
}

export async function clearBridgeLedgersForTest(): Promise<void> {
  await Promise.all([...ledgers.values()].map((ledger) => ledger.delete()));
  ledgers.clear();
}
