import { BrowserKVStore, HttpDocumentStore, type HttpDocumentHeadersHook } from '@openmaic/storage';
import { HttpRuntimeStore, type HttpRuntimeHeadersHook } from '@openmaic/storage/runtime/http';

import {
  assertDocumentStorageConfigurable,
  configureDocumentStorage,
  type DocumentStorageOptions,
} from '@/lib/document-store/config';
import { assertRuntimeStorageConfigurable, configureRuntimeStorage } from '@/lib/runtime/config';
import { getLearnerKey } from '@/lib/runtime/learner-key';

if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_PERSISTENCE === '1') {
  const deviceKv = new BrowserKVStore();
  let learnerKeyPromise: Promise<string> | undefined;
  const learnerKey = (): Promise<string> =>
    (learnerKeyPromise ??= getLearnerKey(deviceKv).catch((error) => {
      learnerKeyPromise = undefined;
      throw error;
    }));

  const token = process.env.NEXT_PUBLIC_PERSISTENCE_TOKEN;
  const headers = async (): Promise<Record<string, string>> => {
    const resolvedLearnerKey = await learnerKey();
    return {
      'x-learner-key': resolvedLearnerKey,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  };

  const runtimeOptions = {
    store: () =>
      new HttpRuntimeStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpRuntimeHeadersHook,
      }),
    learnerKey,
  };
  const documentOptions: DocumentStorageOptions = {
    store: ({ validateScene, validateStage }) =>
      new HttpDocumentStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpDocumentHeadersHook,
        validateScene,
        validateStage,
      }),
  };

  try {
    // Both checks are mutation-free. Once both pass, the synchronous configure
    // calls cannot leave only one seam configured.
    assertRuntimeStorageConfigurable();
    assertDocumentStorageConfigurable();
    configureRuntimeStorage(runtimeOptions);
    configureDocumentStorage(documentOptions);
  } catch (error) {
    console.error(
      'FATAL: server-backed persistence bootstrap failed; no storage seam changes were applied',
      error,
    );
  }
}
