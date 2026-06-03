import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const TEST_STAGE_ID = 'e2e-quiz-stage';
// sidebarCollapsed:false keeps the scene rail open; editInsertToolbarCollapsed
// defaults off so the "Add question" item is visible without expanding.
const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/**
 * #657 — Quiz content surface. Seeds a stage with a single quiz scene, enters
 * Pro mode, and verifies the quiz SceneEditorSurface (a structured form, not a
 * canvas) mounts and wires into the shared chrome: the form renders, editing a
 * field updates reactively, the chrome's "Add question" insert item appends a
 * question, and the per-card delete removes it. The seeded stage is en-US, so
 * accessible-name selectors are stable.
 */
async function seedQuizStage(page: import('@playwright/test').Page) {
  await page.addInitScript((settings) => {
    localStorage.setItem('settings-storage', settings);
  }, SETTINGS_STORAGE);

  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(
    ({ stageId }) => {
      return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');
        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['stages', 'scenes', 'stageOutlines'], 'readwrite');
          const now = Date.now();

          tx.objectStore('stages').put({
            id: stageId,
            name: 'Quiz deck',
            description: '',
            language: 'en-US',
            style: 'professional',
            createdAt: now,
            updatedAt: now,
          });

          tx.objectStore('scenes').put({
            id: 'scene-quiz',
            stageId,
            type: 'quiz',
            title: 'Checkpoint',
            order: 0,
            content: {
              type: 'quiz',
              questions: [
                {
                  id: 'seed-q1',
                  type: 'single',
                  question: 'Seeded question?',
                  options: [
                    { label: 'Yes', value: 'A' },
                    { label: 'No', value: 'B' },
                  ],
                  answer: ['A'],
                  points: 1,
                },
              ],
            },
            createdAt: now,
            updatedAt: now,
          });

          tx.objectStore('stageOutlines').put({
            stageId,
            outlines: [],
            createdAt: now,
            updatedAt: now,
          });

          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });
    },
    { stageId: TEST_STAGE_ID },
  );
}

test.describe('Quiz content surface (#657)', () => {
  test.beforeEach(async ({ page }) => {
    await seedQuizStage(page);
  });

  test('quiz surface mounts in Pro mode; add / edit / delete questions', async ({
    page,
  }, testInfo) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();
    await expect(classroom.sidebarScenes).toHaveCount(1, { timeout: 10_000 });

    // Enter Pro mode (the editor flag is on in the Playwright webServer env).
    await page.getByRole('switch').click();

    // The quiz form renders (not the read-only NOOP fallback) with the seeded
    // question.
    const surface = page.getByTestId('quiz-surface');
    await expect(surface).toBeVisible({ timeout: 10_000 });
    const cards = page.getByTestId('quiz-question');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Seeded question?');

    // --- Edit reactivity: expand the seeded card, retype the question, expect
    // the header summary to reflect the new text (write-through round-trip).
    // The summary toggle is the wide header button carrying the question text.
    await cards
      .first()
      .getByRole('button', { name: /Seeded question/ })
      .click();
    const firstTextarea = cards.first().locator('textarea').first();
    await expect(firstTextarea).toBeVisible({ timeout: 10_000 });
    await firstTextarea.fill('Edited question text');
    await expect(cards.first()).toContainText('Edited question text');

    // --- Add a question via the chrome's floating "Add question" insert item.
    // (Targeted by accessible name: an expanded card also exposes a Plus-icon
    // "Add option" button, so an icon-class selector would be ambiguous.)
    await page.getByRole('button', { name: 'Add question' }).click();
    // The popover offers the three question types; pick single-choice. `exact`
    // avoids matching a question card whose summary contains "Single choice".
    await page.getByRole('button', { name: 'Single choice', exact: true }).click();
    await expect(cards).toHaveCount(2);

    await testInfo.attach('quiz-surface-two-questions', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    // --- Delete the newly added (second) question via its trash button.
    await cards.nth(1).locator('button:has(.lucide-trash-2)').click();
    await expect(cards).toHaveCount(1);
  });
});
