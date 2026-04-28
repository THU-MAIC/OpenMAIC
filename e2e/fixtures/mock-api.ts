import type { Page } from '@playwright/test';
import { mockOutlines } from './test-data/scene-outlines';
import { mockSceneContentResponse } from './test-data/scene-content';
import { createMockSceneActionsResponse } from './test-data/scene-actions';

/**
 * Wraps Playwright's page.route() to mock OpenMAIC API endpoints.
 * Supports both JSON and SSE (text/event-stream) responses.
 */
export class MockApi {
  constructor(private page: Page) {}

  /** Mock the SSE outline streaming endpoint */
  async mockSceneOutlinesStream(outlines = mockOutlines) {
    await this.page.route('**/api/generate/scene-outlines-stream', (route) => {
      const events = outlines
        .map(
          (outline, i) =>
            `data: ${JSON.stringify({ type: 'outline', data: outline, index: i })}\n\n`,
        )
        .join('');
      const done = `data: ${JSON.stringify({ type: 'done', outlines })}\n\n`;

      route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: events + done,
      });
    });
  }

  /** Mock the scene content generation endpoint */
  async mockSceneContent(response = mockSceneContentResponse) {
    await this.page.route('**/api/generate/scene-content', (route) => {
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(response),
      });
    });
  }

  /** Mock the scene actions generation endpoint.
   *  When no stageId is provided, it is extracted from the request body
   *  so the mock response matches the dynamically-generated stage id. */
  async mockSceneActions(stageId?: string) {
    await this.page.route('**/api/generate/scene-actions', async (route) => {
      let id = stageId ?? 'test-stage';
      if (!stageId) {
        try {
          const body = route.request().postDataJSON();
          if (body?.stageId) id = body.stageId;
        } catch {
          // fallback to default
        }
      }
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createMockSceneActionsResponse(id)),
      });
    });
  }

  /** Mock the server providers endpoint (returns empty — client-side config only) */
  async mockServerProviders() {
    await this.page.route('**/api/server-providers', (route) => {
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: {} }),
      });
    });
  }

  /** Set up API mocks for the generation flow. Note: server-providers is already mocked by the base fixture. */
  async setupGenerationMocks(stageId?: string) {
    await this.mockSceneOutlinesStream();
    await this.mockSceneContent();
    await this.mockSceneActions(stageId);
  }
}
