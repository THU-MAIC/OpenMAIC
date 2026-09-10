import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  workspaceFolderAdapter,
  workspaceFoldersAvailable,
  WorkspaceFolderNameError,
} from '@/components/workbench/workspace/workspace-folder-seam';

describe('workspace folder adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the folder control and its actions available together', () => {
    expect(workspaceFoldersAvailable()).toBe(true);
    expect(workspaceFolderAdapter).toBeTruthy();
  });

  it('creates, renames, and removes folders through the landed routes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await workspaceFolderAdapter.create('References');
    await workspaceFolderAdapter.rename('folder/one', 'Reading');
    await workspaceFolderAdapter.removeKeepingCourses('folder/one');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'References' }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/folders/folder%2Fone', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Reading' }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/folders/folder%2Fone?mode=ungroup', {
      method: 'DELETE',
    });
  });

  it.each([
    ['FOLDER_NAME_DUPLICATE', 'duplicate'],
    ['FOLDER_NAME_TOO_LONG', 'tooLong'],
    ['FOLDER_NAME_EMPTY', 'empty'],
    ['FOLDER_NAME_INVALID', 'invalid'],
    ['FOLDER_LIMIT_REACHED', 'limit'],
  ] as const)('maps %s onto the rail error kind %s', async (code, kind) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code, message: 'refused' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(workspaceFolderAdapter.create('name')).rejects.toMatchObject({
      kind,
      message: 'refused',
    } satisfies Partial<WorkspaceFolderNameError>);
  });
});
