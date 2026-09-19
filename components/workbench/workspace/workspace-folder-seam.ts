/** Folder integration for the workspace rail's server-backed course tree. */
export interface WorkspaceFolderAdapter {
  readonly create: (name: string) => Promise<void>;
  readonly rename: (folderId: string, name: string) => Promise<void>;
  readonly removeKeepingCourses: (folderId: string) => Promise<void>;
}

export class WorkspaceFolderNameError extends Error {
  constructor(
    readonly kind: 'duplicate' | 'tooLong' | 'empty' | 'invalid' | 'limit',
    message: string = kind,
  ) {
    super(message);
    this.name = 'WorkspaceFolderNameError';
  }
}

type FolderErrorBody = { error?: { code?: unknown; message?: unknown } };

const ERROR_KINDS = {
  FOLDER_NAME_DUPLICATE: 'duplicate',
  FOLDER_NAME_TOO_LONG: 'tooLong',
  FOLDER_NAME_EMPTY: 'empty',
  FOLDER_NAME_INVALID: 'invalid',
  FOLDER_LIMIT_REACHED: 'limit',
} as const satisfies Record<string, WorkspaceFolderNameError['kind']>;

async function folderRequest(url: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  if (response.ok) return;

  const body = (await response.json().catch(() => null)) as FolderErrorBody | null;
  const code = typeof body?.error?.code === 'string' ? body.error.code : '';
  const kind: WorkspaceFolderNameError['kind'] | undefined =
    ERROR_KINDS[code as keyof typeof ERROR_KINDS];
  if (kind) {
    throw new WorkspaceFolderNameError(
      kind,
      typeof body?.error?.message === 'string' ? body.error.message : code,
    );
  }
  throw new Error(
    typeof body?.error?.message === 'string'
      ? body.error.message
      : `folder request failed (${response.status})`,
  );
}

export const workspaceFolderAdapter: WorkspaceFolderAdapter = {
  create: (name) =>
    folderRequest('/api/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  rename: (folderId, name) =>
    folderRequest(`/api/folders/${encodeURIComponent(folderId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  removeKeepingCourses: (folderId) =>
    folderRequest(`/api/folders/${encodeURIComponent(folderId)}?mode=ungroup`, {
      method: 'DELETE',
    }),
};

export const workspaceFoldersAvailable = (): boolean => workspaceFolderAdapter !== null;
