import type { StageMetaRow } from './stage-meta';

export type DocumentAction =
  | { kind: 'list' }
  | { kind: 'read'; stageId: string }
  | { kind: 'create'; stageId: string }
  | { kind: 'write'; stageId: string }
  | { kind: 'delete'; stageId: string }
  | { kind: 'unknown' };

export type DocumentAccess = 'allow' | 'forbid' | 'not-found';
export type StageMetaReader = (stageId: string) => Promise<StageMetaRow | null>;
export type DocumentExistenceReader = (stageId: string) => Promise<boolean>;

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function isQueryableSegment(value: string): boolean {
  return (
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('\0') &&
    !LONE_SURROGATE.test(value)
  );
}

export function parseDocumentAction(method: string, url: string): DocumentAction {
  let parts: string[];
  try {
    parts = new URL(url, 'http://documents.invalid').pathname
      .split('/')
      .filter((part, index) => index !== 0 || part !== '')
      .map((part) => decodeURIComponent(part));
  } catch {
    return { kind: 'unknown' };
  }
  if (parts[0] !== 'documents') return { kind: 'unknown' };
  if (parts.length === 1) return method === 'GET' ? { kind: 'list' } : { kind: 'unknown' };

  const stageId = parts[1]!;
  if (!isQueryableSegment(stageId)) return { kind: 'unknown' };
  if (parts.length === 2) {
    if (method === 'PUT') return { kind: 'create', stageId };
    if (method === 'GET') return { kind: 'read', stageId };
    if (method === 'DELETE') return { kind: 'delete', stageId };
    return { kind: 'unknown' };
  }
  if (parts.length === 3 && parts[2] === 'stage') {
    return method === 'PUT' ? { kind: 'write', stageId } : { kind: 'unknown' };
  }
  if (parts.length === 4 && parts[2] === 'scenes' && isQueryableSegment(parts[3]!)) {
    if (method === 'GET') return { kind: 'read', stageId };
    if (method === 'PUT' || method === 'DELETE') return { kind: 'write', stageId };
  }
  return { kind: 'unknown' };
}

export async function decideDocumentAccess(
  action: DocumentAction,
  ownerId: string | undefined,
  readMeta: StageMetaReader,
  documentExists: DocumentExistenceReader,
  rereadMeta: StageMetaReader = readMeta,
): Promise<DocumentAccess> {
  if (!ownerId) return 'forbid';
  switch (action.kind) {
    case 'list':
    case 'unknown':
      return 'forbid';
    case 'read': {
      const meta = await readMeta(action.stageId);
      if (!meta) return 'not-found';
      return meta.deletedAt === null ? 'allow' : 'not-found';
    }
    case 'write': {
      const meta = await readMeta(action.stageId);
      if (!meta) return 'not-found';
      if (meta.ownerId !== ownerId) return 'forbid';
      return meta.deletedAt === null ? 'allow' : 'not-found';
    }
    case 'delete': {
      const meta = await readMeta(action.stageId);
      if (!meta || meta.ownerId !== ownerId) return 'forbid';
      return 'allow';
    }
    case 'create': {
      const meta = await readMeta(action.stageId);
      if (meta) {
        if (meta.ownerId !== ownerId) return 'forbid';
        return meta.deletedAt === null ? 'allow' : 'not-found';
      }
      if (!(await documentExists(action.stageId))) return 'allow';
      const concurrentMeta = await rereadMeta(action.stageId);
      if (!concurrentMeta) return 'not-found';
      if (concurrentMeta.ownerId !== ownerId) return 'forbid';
      return concurrentMeta.deletedAt === null ? 'allow' : 'not-found';
    }
  }
}
