import { test, expect } from '../fixtures/base';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage();

const GENERATION_SESSION = JSON.stringify({
  sessionId: 'e2e-test-session',
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

test.describe('Generation Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ settings, session }) => {
        localStorage.setItem('settings-storage', settings);
        sessionStorage.setItem('generationSession', session);
      },
      { settings: SETTINGS_STORAGE, session: GENERATION_SESSION },
    );
  });

  test('completes generation pipeline and redirects to classroom', async ({ page, mockApi }) => {
    // Set up all API mocks
    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    // Generation card with progress dots should be visible
    await expect(preview.stepTitle).toBeVisible();

    // Wait for auto-redirect to classroom
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);
  });
});
