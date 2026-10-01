import type { Page, Route } from '@playwright/test';
import { mockOutlines } from './test-data/scene-outlines';
import { seedServerDocument, uniqueStageId } from './server-seed';
import { createMockSceneActionsResponse } from './test-data/scene-actions';
import {
  createModelSettingsView,
  DEFAULT_MODEL_SETTINGS,
  type ModelSettingsOptions,
} from './test-data/model-settings';

/**
 * Wraps Playwright's page.route() to mock OpenMAIC API endpoints.
 * Supports both JSON and SSE (text/event-stream) responses.
 */
export class MockApi {
  constructor(private page: Page) {}

  /**
   * Answer the workspace model settings (`/api/model-config`): the view the
   * app reads, and a PUT that sets the course model (the toolbar picker). The
   * one-time import of browser settings finds nothing to do (404).
   */
  async mockModelSettings(options: ModelSettingsOptions = DEFAULT_MODEL_SETTINGS) {
    let current = { ...options };
    await this.page.route('**/api/model-config/import', (route) =>
      route.fulfill({ status: 404, body: 'Not found' }),
    );
    await this.page.route('**/api/model-config', async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON() as {
          change?: { kind?: string; set?: Record<string, unknown> };
        };
        const llm = body.change?.kind === 'slots' ? body.change.set?.llm : undefined;
        if (typeof llm === 'string') current = { ...current, llm };
      }
      await route.fulfill({ json: createModelSettingsView(current) });
    });
  }

  /**
   * A scripted server-side generation run behind `/api/generation-runs/**`:
   * starting it streams the outline and waits for confirmation; confirming it
   * stores the first scene's course on the server (as the run's own write
   * would) and completes. The event stream answers from its cursor
   * (`after` / `Last-Event-ID`) like the real one.
   */
  async mockGenerationRun(outlines = mockOutlines): Promise<MockGenerationRun> {
    const run = new MockGenerationRun(this.page, outlines);
    await run.install();
    return run;
  }

  /** Set up API mocks for the generation flow. Note: model settings are already mocked by the base fixture. */
  async setupGenerationMocks() {
    return this.mockGenerationRun();
  }
}

type RunEventFrame = { seq: number; type: string; data: Record<string, unknown> };

export class MockGenerationRun {
  readonly id = `run-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  readonly stageId = uniqueStageId('e2e-run');
  started = false;
  confirmations: Array<Record<string, unknown>> = [];
  private events: RunEventFrame[] = [];
  private state = 'preparing';
  private step: string | null = null;
  private outline: Record<string, unknown> | null = null;
  private courseStageId: string | null = null;
  private input: Record<string, unknown> = {};

  constructor(
    private readonly page: Page,
    private readonly outlines = mockOutlines,
  ) {}

  private push(type: string, data: Record<string, unknown> = {}) {
    this.events.push({ seq: this.events.length + 1, type, data });
    if (type === 'state') {
      this.state = data.state as string;
      this.step = (data.step as string | null) ?? null;
    }
    if (type === 'step_started') this.step = data.step as string;
  }

  snapshot() {
    return {
      id: this.id,
      state: this.state,
      step: this.step,
      seq: this.events.length,
      input: this.input,
      outline: this.outline,
      agents: null,
      stageId: this.courseStageId,
      progress: {
        scenesTotal: this.outline ? this.outlines.length : 0,
        scenesCompleted: this.courseStageId ? this.outlines.length : 0,
      },
      error: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      media: {},
    };
  }

  async install() {
    await this.page.route('**/api/generation-runs**', (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const sse = (body: string) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body,
      });

    if (path === '/api/generation-runs' && method === 'POST') {
      this.input = {
        outlineReview: 'wait',
        ...(request.postDataJSON() as Record<string, unknown>),
      };
      this.started = true;
      this.push('state', { state: 'preparing', step: null });
      this.push('state', { state: 'outlining', step: 'outline' });
      this.push('step_started', { step: 'outline' });
      this.outlines.forEach((outline, index) => this.push('outline_item', { index, outline }));
      this.outline = {
        outlines: this.outlines,
        languageDirective: 'Use Chinese for the generated course.',
        courseTitle: 'Mock Course',
        taskEngineMode: false,
        revision: 1,
      };
      this.push('step_completed', { step: 'outline' });
      this.push('outline_ready', { revision: 1, outline: this.outline });
      this.push('state', { state: 'awaiting_outline_confirmation', step: null });
      return json({ success: true, run: this.snapshot() }, 202);
    }
    if (path === '/api/generation-runs' && method === 'GET') {
      return json({ success: true, runs: [] });
    }
    if (path === '/api/generation-runs/events') {
      return sse(
        `retry: 60000\nevent: runs\ndata: ${JSON.stringify({ type: 'runs', runs: [] })}\n\n`,
      );
    }
    if (
      path !== `/api/generation-runs/${this.id}` &&
      !path.startsWith(`/api/generation-runs/${this.id}/`)
    ) {
      return route.fulfill({ status: 404, body: 'Not found' });
    }
    if (path.endsWith('/events')) {
      const cursor = Number(
        request.headers()['last-event-id'] ?? url.searchParams.get('after') ?? 0,
      );
      const frames = this.events
        .filter((event) => event.seq > cursor)
        .map(
          (event) =>
            `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ runId: this.id, ts: 0, ...event })}\n\n`,
        )
        .join('');
      const caughtUp = `event: caught_up\ndata: ${JSON.stringify({ type: 'caught_up', seq: this.events.length })}\n\n`;
      return sse(`retry: 300\n${frames}${caughtUp}`);
    }
    if (path.endsWith('/confirm-outline') && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      this.confirmations.push(body);
      if (this.state === 'awaiting_outline_confirmation') {
        const outlines = (body.outlines as typeof this.outlines | undefined) ?? this.outlines;
        const revision = body.outlines ? 2 : 1;
        this.outline = { ...this.outline!, outlines, revision };
        this.push('outline_confirmed', { revision, edited: !!body.outlines });
        this.push('state', { state: 'generating', step: null });
        await this.storeCourse(outlines);
        this.push('step_started', { step: 'scene:0:content' });
        this.push('course_created', { stageId: this.stageId });
        this.push('scene_ready', { index: 0, sceneId: 'scene-0', order: 0 });
        this.push('completed', { stageId: this.stageId });
        this.push('state', { state: 'completed', step: null });
      }
      return json({
        success: true,
        state: this.state,
        seq: this.events.length,
        outlineRevision: 1,
      });
    }
    if (method === 'GET') return json({ success: true, run: this.snapshot() });
    return route.fulfill({ status: 404, body: 'Not found' });
  }

  /** The course the run writes, stored the way the run's document write stores it. */
  private async storeCourse(outlines: typeof mockOutlines) {
    const { scene } = createMockSceneActionsResponse(this.stageId);
    await seedServerDocument(this.page, {
      stage: {
        id: this.stageId,
        name: 'Mock Course',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      scenes: [scene],
      outline: { outlines, generationComplete: true, createdAt: Date.now(), updatedAt: Date.now() },
    });
    this.courseStageId = this.stageId;
  }
}
