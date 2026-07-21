import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import type { QuizQuestion } from '../../lib/types/stage';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/**
 * #657 — Quiz content surface, full authoring → playback journey.
 *
 * Two tests:
 *  A. Authoring — in Pro mode, add a question of every type, edit fields, and
 *     delete, asserting the editor reflects each op.
 *  B. Round trip — seed a quiz, edit it in Pro mode, then leave Pro mode and
 *     TAKE the quiz as a learner (answer single / multiple / short-answer,
 *     submit, grade). Asserts the Pro-mode edit actually reaches playback and
 *     that the produced quiz is playable and gradable end to end.
 *
 * The quiz scene is seeded straight into IndexedDB (the editor + generation
 * pipeline don't emit quiz scenes through the mock generator), mirroring how
 * classroom-interaction / interactive-keepalive specs set up a stage.
 */
async function seedQuiz(page: Page, stageId: string, questions: QuizQuestion[]) {
  await page.addInitScript((settings) => {
    localStorage.setItem('settings-storage', settings);
  }, SETTINGS_STORAGE);
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(
    ({ id, qs }) => {
      return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('maic-documents', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('stages', { keyPath: 'id' });
          const scenes = db.createObjectStore('scenes', { keyPath: ['stageId', 'id'] });
          scenes.createIndex('by-stage', 'stageId');
          db.createObjectStore('outlines', { keyPath: 'stageId' });
        };
        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['stages', 'scenes', 'outlines'], 'readwrite');
          const now = Date.now();
          tx.objectStore('stages').put({
            id,
            name: 'Quiz deck',
            description: '',
            language: 'en-US',
            style: 'professional',
            createdAt: now,
            updatedAt: now,
            dslVersion: '0.1.0',
          });
          tx.objectStore('scenes').put({
            id: 'scene-quiz',
            stageId: id,
            type: 'quiz',
            title: 'Checkpoint',
            order: 0,
            content: { type: 'quiz', questions: qs },
            createdAt: now,
            updatedAt: now,
          });
          tx.objectStore('outlines').put({
            stageId: id,
            outline: { outlines: [], createdAt: now, updatedAt: now },
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
    { id: stageId, qs: questions },
  );
}

test.describe('Quiz content surface (#657)', () => {
  test('authoring: add every question type, edit, and delete', async ({ page }, testInfo) => {
    const STAGE = 'e2e-quiz-authoring';
    await seedQuiz(page, STAGE, [
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
    ]);

    const classroom = new ClassroomPage(page);
    await classroom.goto(STAGE);
    await classroom.waitForLoaded();
    await page.getByRole('switch').click(); // enter Pro mode

    const surface = page.getByTestId('quiz-surface');
    await expect(surface).toBeVisible({ timeout: 10_000 });
    const cards = page.getByTestId('quiz-question');
    await expect(cards).toHaveCount(1);

    // Add one of every type via the inline "Add question" action.
    const addType = async (name: string) => {
      await page.getByRole('button', { name: 'Add question' }).click();
      await page.getByRole('button', { name, exact: true }).click();
    };
    await addType('Single choice');
    await addType('Multiple choice');
    await addType('Short answer');
    await expect(cards).toHaveCount(4);
    // Every type is present on the cards (data-question-type attribute).
    await expect(page.locator('[data-question-type="multiple"]')).toHaveCount(1);
    await expect(page.locator('[data-question-type="short_answer"]')).toHaveCount(1);

    // The just-added blank questions surface authoring validation hints.
    await expect(page.getByText(/add question text/i).first()).toBeVisible();

    // Edit the seeded question's text; the header summary reflects it live.
    await cards
      .first()
      .getByRole('button', { name: /Seeded question/ })
      .click();
    await cards.first().locator('textarea').first().fill('Edited in the authoring test');
    await expect(cards.first()).toContainText('Edited in the authoring test');

    await testInfo.attach('authoring-all-types', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    // Delete the last (short-answer) question.
    await cards.nth(3).locator('button:has(.lucide-trash-2)').click();
    await expect(cards).toHaveCount(3);
  });

  test('round trip: edit in Pro mode, then take the quiz and grade it', async ({
    page,
  }, testInfo) => {
    const STAGE = 'e2e-quiz-roundtrip';
    await seedQuiz(page, STAGE, [
      {
        id: 'q-single',
        type: 'single',
        question: 'Capital of France?',
        options: [
          { label: 'Paris', value: 'A' },
          { label: 'Lyon', value: 'B' },
        ],
        answer: ['A'],
        points: 1,
      },
      {
        id: 'q-multi',
        type: 'multiple',
        question: 'Pick the even numbers',
        options: [
          { label: 'Two', value: 'A' },
          { label: 'Three', value: 'B' },
          { label: 'Four', value: 'C' },
        ],
        answer: ['A', 'C'],
        points: 1,
      },
      {
        id: 'q-short',
        type: 'short_answer',
        question: 'Greet the class',
        commentPrompt: 'Expect a greeting.',
        hasAnswer: false,
        points: 1,
      },
    ]);

    // Deterministic AI grading for the short-answer question.
    await page.route('**/api/quiz-grade', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ score: 1, comment: 'Well phrased.' }),
      }),
    );

    const classroom = new ClassroomPage(page);
    await classroom.goto(STAGE);
    await classroom.waitForLoaded();

    // Pro mode has two Pro toggles (the playback header's and the edit chrome's,
    // morphed via layoutId) and only one is the live control at a time. Click
    // switches until the editor surface reaches the desired state, polling with
    // a web-first assertion after each click (no fixed sleeps) and bailing as
    // soon as it flips so a no-op click on the morph ghost can't over-toggle.
    const surface = page.getByTestId('quiz-surface');
    const atTarget = async (on: boolean) => {
      try {
        await expect(surface)[on ? 'toBeVisible' : 'toBeHidden']({ timeout: 1500 });
        return true;
      } catch {
        return false;
      }
    };
    const setProMode = async (on: boolean) => {
      if (await atTarget(on)) return;
      const switches = page.getByRole('switch');
      const n = await switches.count();
      for (let i = 0; i < n; i++) {
        await switches
          .nth(i)
          .click()
          .catch(() => {});
        if (await atTarget(on)) return;
      }
      await expect(surface)[on ? 'toBeVisible' : 'toBeHidden']();
    };

    // --- Author: edit the single-choice question text in Pro mode.
    await setProMode(true);
    const cards = page.getByTestId('quiz-question');
    await expect(cards).toHaveCount(3, { timeout: 10_000 });
    await cards
      .first()
      .getByRole('button', { name: /Capital of France/ })
      .click();
    await cards.first().locator('textarea').first().fill('Capital of France (edited)?');
    await expect(cards.first()).toContainText('Capital of France (edited)?');

    // --- Leave Pro mode and take the quiz as a learner.
    await setProMode(false);
    await expect(page.getByTestId('quiz-surface')).toBeHidden();
    await page.getByRole('button', { name: 'Start Quiz' }).click();

    // The edited question text reaches playback — proves the edit round-trips.
    await expect(page.getByText('Capital of France (edited)?')).toBeVisible({ timeout: 10_000 });

    // Answer: single (Paris), multiple (Two + Four), short-answer (text).
    await page.getByRole('button', { name: /Paris/ }).click();
    await page.getByRole('button', { name: /Two/ }).click();
    await page.getByRole('button', { name: /Four/ }).click();
    await page.getByPlaceholder('Type your answer here...').fill('Hello everyone!');

    await testInfo.attach('playback-answering', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    const submit = page.getByRole('button', { name: 'Submit Answers' });
    await expect(submit).toBeEnabled();
    await submit.click();

    // Grading completes → reviewing. All three correct → 3 / 3.
    await expect(page.getByText('/ 3')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/3\s+correct/i)).toBeVisible();

    await testInfo.attach('playback-results', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
});
