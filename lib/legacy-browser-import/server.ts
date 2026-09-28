/**
 * The importer's own clients for the server, every one of them fenced.
 *
 * Every request carries this browser's id in `X-OpenMAIC-Legacy-Import`, and
 * the server's owner resolution refuses it with `409 LEGACY_IMPORT_NOT_BOUND`
 * unless the owner the request resolves to holds the browser's binding
 * (`lib/persistence/legacy-import-bindings.ts`). So the importer never writes
 * under an owner that does not hold the browser: not after a cookie switch in
 * another tab, not from a page whose memoized owner is stale, not from a tab
 * that lost the binding race. It uses none of the app's persistence seams, and
 * it takes the runtime learner key from the server during each run rather than
 * from the page's memo.
 *
 * The binding request itself carries no header: it is what creates the
 * binding.
 */
import type { AssetMeta } from '@openmaic/dsl';
import {
  HttpAssetStore,
  HttpDocumentStore,
  type DocumentStore,
  type RuntimeStore,
} from '@openmaic/storage';
import { HttpRuntimeStore } from '@openmaic/storage/runtime/http';

import { getDocumentStore, type AppStage } from '@/lib/document-store';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { FolderRecord } from '@/lib/types/folder';
import type { AppScene } from '@/lib/types/stage';
import { FolderNameError } from '@/lib/utils/folder-name-validation';

import type { OwnedStage } from './course';
import type { FolderApi } from './folders';

/** The request header an importer request carries its browser id in. */
export const LEGACY_IMPORT_HEADER = 'x-openmaic-legacy-import';

/** Where the binding is asked for (without the header). */
export const BINDING_ENDPOINT = '/api/identity/legacy-import-binding';

/**
 * Every route the importer's fenced clients reach, with the route module that
 * serves it. `tests/server/identity/legacy-import-binding-route.test.ts`
 * sends each an unbound browser id and requires `409 LEGACY_IMPORT_NOT_BOUND`,
 * so a route added here without the fence fails there.
 */
export const FENCED_ENDPOINTS = [
  {
    method: 'GET',
    path: '/api/persistence/learner-key',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  {
    method: 'GET',
    path: '/api/persistence/documents/:id',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  {
    method: 'PUT',
    path: '/api/persistence/documents/:id',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  {
    method: 'PUT',
    path: '/api/persistence/documents/:id/stage',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  {
    method: 'PUT',
    path: '/api/persistence/documents/:id/scenes/:sceneId',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  {
    method: 'POST',
    path: '/api/persistence/assets',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  {
    method: 'HEAD',
    path: '/api/persistence/assets/:id/content',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  {
    method: 'POST',
    path: '/api/persistence/runtime/sessions',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  {
    method: 'GET',
    path: '/api/persistence/runtime/sessions/:id',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  {
    method: 'POST',
    path: '/api/persistence/runtime/sessions/:id/records',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  {
    method: 'GET',
    path: '/api/persistence/runtime/sessions/:id/records',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  {
    method: 'GET',
    path: '/api/persistence/runtime/stages/:s/learners/:l/sessions',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  {
    method: 'GET',
    path: '/api/persistence/assets/:id/content',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  {
    method: 'PATCH',
    path: '/api/persistence/runtime/sessions/:id/status',
    route: 'app/api/persistence/[...path]/route.ts',
  },
  { method: 'GET', path: '/api/stages', route: 'app/api/stages/route.ts' },
  { method: 'GET', path: '/api/folders', route: 'app/api/folders/route.ts' },
  { method: 'POST', path: '/api/folders', route: 'app/api/folders/route.ts' },
  { method: 'POST', path: '/api/folders/members', route: 'app/api/folders/members/route.ts' },
] as const;

/** What the importer needs from the server, all of it bound to one browser id. */
export interface ImportClients {
  /** Bind the browser to the requesting owner (atomic); whether that owner holds it. */
  bind(): Promise<boolean>;
  /** The requesting owner's runtime learner key, asked now (never the page memo). */
  learnerKey(): Promise<string>;
  readonly documents: DocumentStore<AppScene, AppStage>;
  readonly runtime: RuntimeStore;
  putAsset(data: Blob, meta: AssetMeta): Promise<string>;
  assetExists(ref: string): Promise<boolean>;
  listOwnedStages(): Promise<OwnedStage[]>;
  readonly folders: FolderApi;
}

/** A refusal carrying the server's status and code, as the other clients' errors do. */
async function httpFailure(response: Response, what: string): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: unknown; message?: unknown };
  } | null;
  const code = typeof body?.error?.code === 'string' ? body.error.code : undefined;
  const message =
    typeof body?.error?.message === 'string'
      ? body.error.message
      : `${what}: HTTP ${response.status}`;
  return Object.assign(new Error(message), {
    status: response.status,
    ...(code ? { code } : {}),
  });
}

function folderError(error: Error & { code?: string }): Error {
  switch (error.code) {
    case 'FOLDER_NAME_DUPLICATE':
      return new FolderNameError(error.message, 'duplicate');
    case 'FOLDER_LIMIT_REACHED':
      return new FolderNameError(error.message, 'limit');
    case 'FOLDER_NAME_TOO_LONG':
      return new FolderNameError(error.message, 'tooLong');
    case 'FOLDER_NAME_EMPTY':
      return new FolderNameError(error.message, 'empty');
    default:
      return error;
  }
}

/** The fenced clients for `browserId`, over `fetchImpl` (the global fetch by default). */
export function connectImportServer(
  browserId: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): ImportClients {
  const fence = { [LEGACY_IMPORT_HEADER]: browserId };
  const request = (path: string, init: RequestInit = {}) =>
    fetchImpl(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { ...fence, ...(init.headers as Record<string, string> | undefined) },
    });
  const documents = getDocumentStore({
    store: new HttpDocumentStore<AppScene, AppStage>({
      baseUrl: '/api/persistence',
      fetch: fetchImpl,
      headers: () => fence,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }),
  });
  const runtime = new HttpRuntimeStore({
    baseUrl: '/api/persistence',
    fetch: fetchImpl,
    headers: () => fence,
  });
  const assets = new HttpAssetStore({
    baseUrl: '/api/persistence',
    fetch: fetchImpl,
    headers: () => fence,
  });

  const json = async <T>(path: string, init: RequestInit, what: string): Promise<T> => {
    const response = await request(path, init);
    if (!response.ok) throw await httpFailure(response, what);
    return (await response.json()) as T;
  };

  const folders: FolderApi = {
    async list() {
      const body = await json<{ folders?: FolderRecord[] }>('/api/folders', {}, 'list folders');
      return (body.folders ?? []).map(({ id, name, order, createdAt, updatedAt }) => ({
        id,
        name,
        order,
        createdAt,
        updatedAt,
      }));
    },
    async create(name) {
      try {
        const body = await json<{ folder: FolderRecord }>(
          '/api/folders',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          },
          'create folder',
        );
        return body.folder;
      } catch (error) {
        throw folderError(error as Error & { code?: string });
      }
    },
    async setMembership(stageId, folderId) {
      await json<unknown>(
        '/api/folders/members',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stageId, folderId }),
        },
        'file course',
      );
    },
  };

  return {
    async bind() {
      // No fence header: this is the request that creates the binding.
      const response = await fetchImpl(BINDING_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ browserId }),
      });
      if (!response.ok) throw await httpFailure(response, 'bind this browser');
      const body = (await response.json()) as { bound?: unknown };
      return body.bound === true;
    },
    async learnerKey() {
      const body = await json<{ learnerKey?: unknown }>(
        '/api/persistence/learner-key',
        {},
        'learner key',
      );
      if (typeof body.learnerKey !== 'string' || body.learnerKey === '') {
        throw new Error('The runtime learner key response is malformed');
      }
      return body.learnerKey;
    },
    documents,
    runtime,
    putAsset: (data, meta) => assets.put(data, meta),
    assetExists: (ref) => assets.exists(ref),
    async listOwnedStages() {
      const body = await json<{ stages?: { id: string; folderId?: string }[] }>(
        '/api/stages',
        {},
        'list courses',
      );
      return (body.stages ?? []).map((stage) => ({
        id: stage.id,
        ...(stage.folderId ? { folderId: stage.folderId } : {}),
      }));
    },
    folders,
  };
}
