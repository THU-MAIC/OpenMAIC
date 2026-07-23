import { BrowserKVStore, HttpDocumentStore, type HttpDocumentHeadersHook } from '@openmaic/storage';
import { HttpRuntimeStore, type HttpRuntimeHeadersHook } from '@openmaic/storage/runtime/http';

import { configureDocumentStorage } from '@/lib/document-store';
import { configureRuntimeStorage } from '@/lib/runtime/store';
import { getLearnerKey } from '@/lib/runtime/learner-key';

if (process.env.NEXT_PUBLIC_PERSISTENCE === '1') {
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

  configureRuntimeStorage({
    store: () =>
      new HttpRuntimeStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpRuntimeHeadersHook,
      }),
    learnerKey,
  });
  configureDocumentStorage({
    store: ({ validateScene, validateStage }) =>
      new HttpDocumentStore({
        baseUrl: '/api/persistence',
        headers: headers satisfies HttpDocumentHeadersHook,
        validateScene,
        validateStage,
      }),
  });
}
