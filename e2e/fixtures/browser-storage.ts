import type { Page } from '@playwright/test';

export async function primeOrigin(page: Page) {
  await page.goto('/', { waitUntil: 'networkidle' });
}

export async function setSettingsStorage(page: Page, settings: string) {
  await primeOrigin(page);
  await page.localStorage.setItem('settings-storage', settings);
}

export async function setSettingsAndGenerationSession(
  page: Page,
  options: {
    settings: string;
    session: string;
  },
) {
  await primeOrigin(page);
  await page.localStorage.setItem('settings-storage', options.settings);
  await page.sessionStorage.setItem('generationSession', options.session);
}

export async function ensureMaicDatabase(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const request = indexedDB.open('MAIC-Database');

        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const hasStores = ['stages', 'scenes', 'stageOutlines'].every((name) =>
            db.objectStoreNames.contains(name),
          );
          db.close();
          resolve(hasStores);
        };

        request.onerror = () => resolve(false);
      }),
    undefined,
    { timeout: 15_000 },
  );
}
