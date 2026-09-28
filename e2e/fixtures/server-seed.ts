/**
 * Seed courses through the server, the way the app itself stores them.
 *
 * Every course lives on the server behind the embedded persistence endpoint,
 * so a spec that needs a course writes it with the same `PUT
 * /api/persistence/documents/:stageId` the browser's document store uses.
 * `page.request` shares the page's cookie jar: the anonymous owner cookie the
 * first write mints is the one the page then browses with, so the seeded
 * course belongs to the browser under test.
 */
import type { Page } from '@playwright/test';

// The workspace packages are ESM-only while Playwright loads specs as
// CommonJS, so they are imported dynamically where they are used.

export interface SeedDocument {
  readonly stage: { readonly id: string } & Record<string, unknown>;
  readonly scenes: ReadonlyArray<Record<string, unknown>>;
  readonly outline?: Record<string, unknown>;
}

/**
 * A course id no other test (or earlier run against the same database) holds.
 * Course ids are global on the server, and a course another owner created
 * cannot be written, so fixed ids would collide across parallel workers.
 */
export function uniqueStageId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Store one course document as the page's owner. */
export async function seedServerDocument(page: Page, document: SeedDocument): Promise<void> {
  const { DSL_VERSION } = await import('@openmaic/dsl');
  const path = `/api/persistence/documents/${encodeURIComponent(document.stage.id)}`;
  const response = await page.request.put(path, {
    data: { dslVersion: DSL_VERSION, ...document },
  });
  if (response.status() !== 204) {
    throw new Error(
      `Seeding course ${document.stage.id} failed: HTTP ${response.status()} ${await response.text()}`,
    );
  }
}

/** Read one course document back as the page's owner, or null when it does not exist. */
export async function readServerDocument(
  page: Page,
  stageId: string,
): Promise<{ stage: Record<string, unknown>; scenes: Array<Record<string, unknown>> } | null> {
  const response = await page.request.get(
    `/api/persistence/documents/${encodeURIComponent(stageId)}`,
  );
  if (response.status() === 404) return null;
  if (!response.ok()) {
    throw new Error(`Reading course ${stageId} failed: HTTP ${response.status()}`);
  }
  return response.json();
}

/** Remember which scene the editor opens a course on (device-local state). */
export async function setCurrentScene(page: Page, stageId: string, sceneId: string): Promise<void> {
  await page.evaluate(
    ({ stageId, sceneId }) => {
      localStorage.setItem(
        `maic:device:editor-current-scene:${stageId}`,
        JSON.stringify({ sceneId, updatedAt: new Date().toISOString() }),
      );
    },
    { stageId, sceneId },
  );
}

/**
 * Store bytes in the page owner's asset pool and return the allocated id, the
 * reference a seeded document holds. Goes through the package's own HTTP
 * client, carried over `page.request` so it shares the page's owner cookie.
 */
export async function seedServerAsset(
  page: Page,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const { HttpAssetStore } = await import('@openmaic/storage/asset/http');
  const store = new HttpAssetStore({
    baseUrl: '/api/persistence',
    fetch: async (input, init) => {
      const body =
        init?.body === undefined || init.body === null
          ? undefined
          : Buffer.from(await new Response(init.body).arrayBuffer());
      const response = await page.request.fetch(String(input), {
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(body === undefined ? {} : { data: body }),
      });
      return new Response(response.status() === 204 ? null : await response.body(), {
        status: response.status(),
        headers: response.headers(),
      });
    },
  });
  return store.put(new Blob([bytes], { type: contentType }), { contentType });
}
