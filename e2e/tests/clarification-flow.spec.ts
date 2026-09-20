import { test, expect } from '../fixtures/base';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { HomePage } from '../pages/home.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage();

const GENERATION_SESSION = JSON.stringify({
  sessionId: 'e2e-clarify-session',
  requirements: {
    requirement: '讲解光合作用',
    language: 'zh-CN',
  },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: null,
  currentStep: 'generating',
});

test.describe('Clarification Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ settings, session }) => {
        localStorage.setItem('maic:account:settings-storage', settings);
        sessionStorage.setItem('generationSession', session);
      },
      { settings: SETTINGS_STORAGE, session: GENERATION_SESSION },
    );
  });

  test('pauses for user answers and injects them into the outline request', async ({
    page,
    mockApi,
  }) => {
    await mockApi.mockClarify({
      needsClarification: true,
      questions: [
        {
          id: 'q1',
          question: 'How long should the course be?',
          options: [
            { id: 'standard', label: 'Standard (15-20 min)' },
            { id: 'deep', label: 'Deep dive (30+ min)' },
          ],
          allowFreeText: true,
        },
      ],
    });
    await mockApi.mockSceneOutlinesStream();
    await mockApi.mockSceneContent();
    await mockApi.mockSceneActions();

    let outlineBody: { clarificationQA?: unknown } | null = null;
    page.on('request', (request) => {
      if (
        request.url().includes('/api/generate/scene-outlines-stream') &&
        request.method() === 'POST'
      ) {
        try {
          outlineBody = request.postDataJSON() as { clarificationQA?: unknown };
        } catch {
          // ignore unparseable bodies
        }
      }
    });

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    // Pipeline pauses on the clarifying panel before any outline streams.
    await expect(page.getByTestId('clarification-panel')).toBeVisible();
    // The questions live inside the pipeline card: the step title stays visible.
    await expect(preview.stepTitle).toBeVisible();

    await page.getByTestId('clarification-option-q1-standard').click();
    await page.getByTestId('clarification-freetext-q1').fill('For kids');
    await page.getByTestId('clarification-submit').click();

    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);
    expect(outlineBody?.clarificationQA).toEqual([
      {
        question: 'How long should the course be?',
        answer: 'Standard (15-20 min); For kids',
      },
    ]);
  });

  test('skip resumes generation without clarification answers', async ({ page, mockApi }) => {
    await mockApi.mockClarify({
      needsClarification: true,
      questions: [
        {
          id: 'q1',
          question: 'How long should the course be?',
          options: [{ id: 'standard', label: 'Standard (15-20 min)' }],
        },
      ],
    });
    await mockApi.mockSceneOutlinesStream();
    await mockApi.mockSceneContent();
    await mockApi.mockSceneActions();

    let outlineBody: { clarificationQA?: unknown } | null = null;
    page.on('request', (request) => {
      if (
        request.url().includes('/api/generate/scene-outlines-stream') &&
        request.method() === 'POST'
      ) {
        try {
          outlineBody = request.postDataJSON() as { clarificationQA?: unknown };
        } catch {
          // ignore unparseable bodies
        }
      }
    });

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await expect(page.getByTestId('clarification-panel')).toBeVisible();
    await expect(preview.stepTitle).toBeVisible();
    await page.getByTestId('clarification-skip').click();

    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);
    expect(outlineBody?.clarificationQA).toBeUndefined();
  });

  test('back returns to the requirements form', async ({ page, mockApi }) => {
    await mockApi.mockClarify({
      needsClarification: true,
      questions: [{ id: 'q1', question: 'How long should the course be?' }],
    });

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await expect(page.getByTestId('clarification-panel')).toBeVisible();
    await expect(preview.stepTitle).toBeVisible();
    await page.getByTestId('clarification-back').click();

    const home = new HomePage(page);
    await expect(home.textarea).toBeVisible();
  });
});
